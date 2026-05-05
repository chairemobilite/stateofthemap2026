//! Overpass API client for the POI-pick analysis step.
//!
//! Given a bbox and a [`PoiTagConfig`], query Overpass for every
//! matching OSM feature in one shot, then annotate each returned
//! element with the group it matched (resolved client-side via the
//! same `PoiTagConfig` to avoid emitting N separate queries).
//!
//! Exceptions from `poi_tags.yml` are pushed into the QL itself as
//! `!=` filters, so excluded features never come back over the wire;
//! [`PoiTagConfig::group_for_tags`] still re-checks them client-side
//! as a defense-in-depth safety net.
//!
//! Only the public methods that the HTTP handler needs are exposed
//! here; the QL builder is also public so the handler's integration
//! tests can assert on its output without hitting the network.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::bbox::Bbox;
use crate::poi_config::{Exception, PoiTagConfig};

/// OSM feature kind. Mirrors the three values Overpass emits in the
/// `type` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OsmType {
    Node,
    Way,
    Relation,
}

impl OsmType {
    /// Decode the `type` field of one Overpass element. Visible to
    /// sibling crate modules (e.g. `poi_focus`) so they can route on
    /// element kind without re-implementing the lookup.
    pub(crate) fn from_overpass(raw: &str) -> Option<Self> {
        match raw {
            "node" => Some(Self::Node),
            "way" => Some(Self::Way),
            "relation" => Some(Self::Relation),
            _ => None,
        }
    }

    /// Lowercase Overpass QL keyword for this type.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Way => "way",
            Self::Relation => "relation",
        }
    }
}

/// Parse `node/123`, `way/456`, or `relation/789` (optional spaces).
pub fn parse_osm_ref(raw: &str) -> Result<(OsmType, i64), String> {
    let s = raw.trim();
    let (kind, id_part) = s
        .split_once('/')
        .ok_or_else(|| "expected node/123, way/456, or relation/789".to_string())?;
    let id: i64 = id_part
        .trim()
        .parse()
        .map_err(|_| format!("invalid OSM id in {s:?}"))?;
    if id <= 0 {
        return Err("OSM id must be positive".into());
    }
    let osm_type = match kind.trim().to_lowercase().as_str() {
        "node" => OsmType::Node,
        "way" => OsmType::Way,
        "relation" => OsmType::Relation,
        other => {
            return Err(format!("type must be node, way, or relation (got {other:?})"));
        }
    };
    Ok((osm_type, id))
}

/// One-element Overpass query: `out center tags` yields node lat/lon or way/relation centroid.
pub fn build_osm_anchor_query(osm_type: OsmType, id: i64) -> String {
    format!(
        "[out:json][timeout:{t}];\n{ty}({id});\nout center tags;\n",
        t = OVERPASS_QUERY_TIMEOUT_S,
        ty = osm_type.as_str(),
        id = id,
    )
}

/// One picked POI, tagged with the group it matched in
/// `config/poi_tags.yml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Poi {
    pub osm_type: OsmType,
    pub osm_id: i64,
    /// `[lon, lat]` — GeoJSON order, matches [`Bbox::center`].
    pub center: [f64; 2],
    pub tags: BTreeMap<String, String>,
    /// Name of the matching group from `poi_tags.yml`.
    pub group: String,
}

/// Default connect + read timeout. Overpass caps server-side at 25 s
/// by default; we give a small cushion for the round-trip.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Matches the `[timeout:N]` setting embedded in every QL query.
const OVERPASS_QUERY_TIMEOUT_S: u32 = 25;

/// HTTP client wired to an Overpass endpoint.
#[derive(Debug, Clone)]
pub struct OverpassClient {
    http: reqwest::Client,
    url: String,
}

impl OverpassClient {
    /// Build a client pointing at an Overpass `/api/interpreter`
    /// endpoint. The URL is taken verbatim from config (env-var
    /// `OVERPASS_URL`), so the operator controls which mirror to use.
    pub fn new(url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            // Identify the tool in Overpass's logs — the public
            // instance asks integrators to send a descriptive UA.
            .user_agent(concat!(
                "entrance-analyser-backend/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/chairemobilite/stateofthemap2026)"
            ))
            .build()
            .expect("reqwest::Client::build with static settings is infallible");
        Self {
            http,
            url: url.into(),
        }
    }

    /// Fetch every POI inside `bbox` that matches any expression in
    /// `config`. Returned POIs are annotated with their group via
    /// [`PoiTagConfig::group_for_tags`]; features whose tags match
    /// none of the groups (shouldn't happen since Overpass filters
    /// from the same expressions) are dropped.
    pub async fn fetch_pois(
        &self,
        bbox: &Bbox,
        config: &PoiTagConfig,
    ) -> Result<Vec<Poi>, OverpassError> {
        let parsed: OverpassResponse = self.execute_ql(&build_query(bbox, config)).await?;
        Ok(parsed
            .elements
            .into_iter()
            .filter_map(|raw| raw.into_poi(config))
            .collect())
    }

    /// Resolve one OSM object's representative point via Overpass `out center`
    /// (node → coordinates; way/relation polygon → computed centre).
    pub async fn fetch_osm_anchor_center(
        &self,
        osm_type: OsmType,
        id: i64,
    ) -> Result<([f64; 2], BTreeMap<String, String>), OverpassError> {
        let ql = build_osm_anchor_query(osm_type, id);
        let parsed: OverpassResponse = self.execute_ql(&ql).await?;
        let el = take_matching_anchor_element(parsed.elements, osm_type, id)?;
        let center = el
            .center_lon_lat()
            .ok_or(OverpassError::InvalidOsmGeometry)?;
        Ok((center, el.tags))
    }

    /// POST a raw Overpass QL query and decode the response as `T`.
    ///
    /// Centralises the transport concerns (form encoding, HTTP status
    /// check, JSON decode) so callers can focus on building the query
    /// and shaping the typed response. Public to the crate so sibling
    /// modules (e.g. `poi_focus`) reuse the same configured client.
    pub(crate) async fn execute_ql<T: serde::de::DeserializeOwned>(
        &self,
        ql: &str,
    ) -> Result<T, OverpassError> {
        let response = self
            .http
            .post(&self.url)
            .form(&[("data", ql)])
            .send()
            .await
            .map_err(OverpassError::Network)?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(OverpassError::Http {
                status: status.as_u16(),
                body,
            });
        }
        response.json().await.map_err(OverpassError::Decode)
    }
}

/// Build the Overpass QL query for one bbox and every group in
/// `config`. Each group expression becomes one `nwr[...]` line; any
/// **single-tag** exception sharing the line's key is appended as a
/// `!=` negation so vacant storefronts, benches, and the rest of the
/// flat `exceptions:` list never travel back over the wire. Public
/// so tests can assert on the output without a network round-trip.
///
/// A wildcard exception on a key (`amenity=*`) drops every group
/// line that filters on that same key — the line would be empty by
/// construction, and Overpass rejects `[key!=*]` syntax.
///
/// **Conjunctive (`all:`) exceptions are intentionally NOT pushed
/// into the QL.** Overpass cannot express `NOT (a AND b)` on a
/// single `nwr` filter — every `[...]` clause is AND'd. Splitting the
/// affected group line into a union of two filtered lines would work
/// but adds enough builder complexity that the savings (a handful of
/// extra elements over the wire for the rare conjunctive case) are
/// not worth it. The post-fetch [`PoiTagConfig::group_for_tags`]
/// safety net catches them client-side, where the predicate is
/// trivial.
pub fn build_query(bbox: &Bbox, config: &PoiTagConfig) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    writeln!(
        &mut out,
        "[out:json][timeout:{OVERPASS_QUERY_TIMEOUT_S}][bbox:{s},{w},{n},{e}];",
        s = bbox.south,
        w = bbox.west,
        n = bbox.north,
        e = bbox.east,
    )
    .unwrap();
    out.push_str("(\n");
    for exprs in config.groups.values() {
        'lines: for expr in exprs {
            // `nwr` queries nodes + ways + relations in a single
            // clause (Overpass QL shortcut).
            let mut line = match &expr.value {
                None => format!("nwr[{:?}]", expr.key),
                Some(v) => format!("nwr[{:?}={:?}]", expr.key, v),
            };
            for exc in &config.exceptions {
                let Exception::Single(exc_expr) = exc else { continue };
                if exc_expr.key != expr.key {
                    continue;
                }
                match &exc_expr.value {
                    None => continue 'lines,
                    Some(v) => write!(&mut line, "[{:?}!={:?}]", exc_expr.key, v).unwrap(),
                }
            }
            writeln!(&mut out, "    {line};").unwrap();
        }
    }
    out.push_str(");\nout center tags;\n");
    out
}

// ---------- raw response types (crate-private) ----------

#[derive(Debug, Deserialize)]
struct OverpassResponse {
    elements: Vec<RawElement>,
}

#[derive(Debug, Deserialize)]
struct RawElement {
    #[serde(rename = "type")]
    osm_type: String,
    id: i64,
    #[serde(default)]
    lat: Option<f64>,
    #[serde(default)]
    lon: Option<f64>,
    /// Present for ways/relations when the query asks for `out center`.
    #[serde(default)]
    center: Option<LatLon>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct LatLon {
    lat: f64,
    lon: f64,
}

/// Pick the Overpass element that matches the requested `type(id)`.
///
/// Some mirrors or future QL variants can append extra `elements` (e.g. a
/// leading object without geometry). Using `.next()` would mis-read the
/// centre; we always resolve by `type` + `id`.
fn take_matching_anchor_element(
    elements: Vec<RawElement>,
    osm_type: OsmType,
    id: i64,
) -> Result<RawElement, OverpassError> {
    let want = osm_type.as_str();
    elements
        .into_iter()
        .find(|e| e.osm_type.eq_ignore_ascii_case(want) && e.id == id)
        .ok_or(OverpassError::NoOsmElement)
}

impl RawElement {
    /// `[lon, lat]` from node `lat`/`lon` or from `out center` on ways/relations.
    fn center_lon_lat(&self) -> Option<[f64; 2]> {
        match (self.lat, self.lon, self.center.as_ref()) {
            (Some(lat), Some(lon), _) => Some([lon, lat]),
            (_, _, Some(c)) => Some([c.lon, c.lat]),
            _ => None,
        }
    }

    /// Turn a raw Overpass element into a [`Poi`], dropping elements
    /// that lack a usable center or whose tags match no group.
    fn into_poi(self, config: &PoiTagConfig) -> Option<Poi> {
        let osm_type = OsmType::from_overpass(&self.osm_type)?;
        let group = config.group_for_tags(&self.tags)?.to_string();
        let center = self.center_lon_lat()?;
        Some(Poi {
            osm_type,
            osm_id: self.id,
            center,
            tags: self.tags,
            group,
        })
    }
}

// ---------- errors ----------

/// Every failure mode `fetch_pois` can hit.
#[derive(Debug)]
pub enum OverpassError {
    /// Overpass returned no element for the requested `type(id)`.
    NoOsmElement,
    /// Element lacked coordinates / `center` (unexpected for `out center`).
    InvalidOsmGeometry,
    /// Connection error, TLS failure, timeout, DNS — all reqwest
    /// transport failures collapse here.
    Network(reqwest::Error),
    /// Overpass returned a non-2xx HTTP status. `body` carries the
    /// server's response so the HTTP layer can log it.
    Http { status: u16, body: String },
    /// 2xx response but the body did not deserialize into the
    /// documented Overpass JSON shape.
    Decode(reqwest::Error),
}

impl std::fmt::Display for OverpassError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoOsmElement => write!(f, "OSM object not found in Overpass"),
            Self::InvalidOsmGeometry => write!(f, "OSM object has no usable centre coordinates"),
            Self::Network(e) => write!(f, "Overpass transport failure: {e}"),
            Self::Http { status, body } => {
                let excerpt: String = body.chars().take(200).collect();
                write!(f, "Overpass HTTP {status}: {excerpt}")
            }
            Self::Decode(e) => write!(f, "Overpass response decode failure: {e}"),
        }
    }
}

impl std::error::Error for OverpassError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bbox::CandidateSource;
    use crate::poi_config::PoiTagConfig;
    use uuid::Uuid;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn sample_config(yaml: &str) -> PoiTagConfig {
        PoiTagConfig::from_yaml_str(yaml).unwrap()
    }

    fn sample_bbox() -> Bbox {
        Bbox {
            id: Uuid::nil(),
            west: -73.60,
            south: 45.50,
            east: -73.50,
            north: 45.60,
            center: [-73.55, 45.55],
            cell_size_km: 10,
            population: 0.0,
            density_per_km2: 0.0,
            max_density_ratio: 0.0,
            built_volume: 0.0,
            max_built_volume_ratio: 0.0,
            candidate_source: CandidateSource::Random,
            custom_osm_type: None,
            custom_osm_id: None,
        }
    }

    /// Strip the leading whitespace + `;` so assertions can compare
    /// just the `nwr[...]` body without baking the formatting choice
    /// into every test. Returns owned strings so callers can pass an
    /// inline `build_query(...)` without keeping the buffer alive.
    fn group_lines(ql: &str) -> Vec<String> {
        ql.lines()
            .filter_map(|l| l.trim().strip_suffix(';').map(str::trim))
            .filter(|l| l.starts_with("nwr"))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn query_includes_bbox_and_every_group_expression() {
        let cfg = sample_config(
            "groups:\n    shops:\n        - shop=*\n    \
             public_transport:\n        - highway=bus_stop\n        - railway=tram_stop\n",
        );
        let ql = build_query(&sample_bbox(), &cfg);
        assert!(
            ql.contains("[bbox:45.5,-73.6,45.6,-73.5]"),
            "missing bbox: {ql}"
        );
        assert!(ql.contains("nwr[\"shop\"];"), "missing wildcard line: {ql}");
        assert!(
            ql.contains("nwr[\"highway\"=\"bus_stop\"];"),
            "missing exact match line: {ql}"
        );
        assert!(
            ql.contains("nwr[\"railway\"=\"tram_stop\"];"),
            "missing second exact match: {ql}"
        );
        assert!(ql.contains("out center tags;"), "missing out clause: {ql}");
    }

    #[test]
    fn query_attaches_exception_negations_to_matching_group_lines() {
        // `shop=*` line should pick up every `shop=...` exception as
        // a `!=` filter; the unrelated `highway=bus_stop` line stays
        // bare because no exception shares its key.
        let cfg = sample_config(
            "groups:\n    shops:\n        - shop=*\n    \
             public_transport:\n        - highway=bus_stop\n\
             exceptions:\n    - shop=vacant\n    - shop=no\n    - amenity=bench\n",
        );
        let lines = group_lines(&build_query(&sample_bbox(), &cfg));
        assert_eq!(
            lines,
            vec![
                "nwr[\"shop\"][\"shop\"!=\"vacant\"][\"shop\"!=\"no\"]",
                "nwr[\"highway\"=\"bus_stop\"]",
            ],
        );
    }

    #[test]
    fn query_skips_group_line_when_an_exception_is_wildcard_on_same_key() {
        // `amenity=*` exception disqualifies the entire amenity key
        // -- emitting `[amenity!=*]` is invalid Overpass QL, so the
        // group line is dropped. The `shop=*` line survives because
        // its key isn't wildcard-excepted.
        let cfg = sample_config(
            "groups:\n    shops:\n        - shop=*\n    amenities:\n        - amenity=*\n\
             exceptions:\n    - amenity=*\n",
        );
        let lines = group_lines(&build_query(&sample_bbox(), &cfg));
        assert_eq!(lines, vec!["nwr[\"shop\"]"]);
    }

    #[test]
    fn query_omits_conjunctive_exceptions_from_ql() {
        // Conjunctive exceptions (e.g. private swimming pools) are
        // enforced client-side; the QL must not pick them up — both
        // because Overpass can't express `NOT (a AND b)` on a single
        // `nwr` filter and because emitting a half-baked `[access!=
        // private]` filter on the leisure line would over-exclude
        // every private leisure feature, not just pools.
        let cfg = sample_config(
            "groups:\n    leisure:\n        - leisure=*\n\
             exceptions:\n    - all:\n        - leisure=swimming_pool\n        - access=private\n",
        );
        let lines = group_lines(&build_query(&sample_bbox(), &cfg));
        assert_eq!(lines, vec!["nwr[\"leisure\"]"]);
    }

    #[test]
    fn query_does_not_attach_exception_to_unrelated_group_line() {
        // A `craft=*` group with `amenity=bench` exceptions must not
        // pick up the bench negation -- exceptions are scoped to
        // their key.
        let cfg = sample_config(
            "groups:\n    crafts:\n        - craft=*\n\
             exceptions:\n    - amenity=bench\n",
        );
        let lines = group_lines(&build_query(&sample_bbox(), &cfg));
        assert_eq!(lines, vec!["nwr[\"craft\"]"]);
    }

    fn make_response(elements: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "version": 0.6,
            "generator": "Overpass API mock",
            "elements": elements,
        })
    }

    #[tokio::test]
    async fn parses_node_way_relation_elements_and_assigns_groups() {
        let server = MockServer::start().await;
        let body = make_response(serde_json::json!([
            {
                "type": "node",
                "id": 101,
                "lat": 45.55,
                "lon": -73.55,
                "tags": {"shop": "bakery", "name": "Test Bakery"}
            },
            {
                "type": "way",
                "id": 202,
                "center": {"lat": 45.56, "lon": -73.54},
                "tags": {"highway": "bus_stop"}
            },
            {
                "type": "relation",
                "id": 303,
                "center": {"lat": 45.57, "lon": -73.53},
                "tags": {"railway": "tram_stop"}
            },
        ]));
        Mock::given(method("POST"))
            .and(path("/api/interpreter"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let cfg = sample_config(
            "groups:\n    shops:\n        - shop=*\n    \
             public_transport:\n        - highway=bus_stop\n        - railway=tram_stop\n",
        );
        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let pois = client.fetch_pois(&sample_bbox(), &cfg).await.unwrap();

        assert_eq!(pois.len(), 3);
        assert_eq!(pois[0].osm_type, OsmType::Node);
        assert_eq!(pois[0].osm_id, 101);
        assert_eq!(pois[0].group, "shops");
        assert_eq!(pois[0].center, [-73.55, 45.55]);
        assert_eq!(pois[1].osm_type, OsmType::Way);
        assert_eq!(pois[1].group, "public_transport");
        assert_eq!(pois[2].osm_type, OsmType::Relation);
        assert_eq!(pois[2].group, "public_transport");
    }

    #[tokio::test]
    async fn drops_elements_matching_an_exception() {
        // The shipped YAML treats `shop=vacant` as a non-POI; the
        // overpass client must round-trip that semantics via
        // `PoiTagConfig::group_for_tags`.
        let server = MockServer::start().await;
        let body = make_response(serde_json::json!([
            {"type": "node", "id": 10, "lat": 45.55, "lon": -73.55,
             "tags": {"shop": "bakery"}},
            {"type": "node", "id": 11, "lat": 45.56, "lon": -73.55,
             "tags": {"shop": "vacant"}},
        ]));
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let cfg = sample_config(
            "groups:\n    shops:\n        - shop=*\nexceptions:\n    - shop=vacant\n",
        );
        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let pois = client.fetch_pois(&sample_bbox(), &cfg).await.unwrap();
        assert_eq!(pois.len(), 1, "vacant storefront must be dropped");
        assert_eq!(pois[0].osm_id, 10);
    }

    #[tokio::test]
    async fn drops_elements_matching_a_conjunctive_exception_client_side() {
        // The QL doesn't filter conjunctive exceptions (see
        // `query_omits_conjunctive_exceptions_from_ql`), so Overpass
        // happily returns the private pool. The client-side
        // `group_for_tags` safety net must drop it; the public pool
        // must survive.
        let server = MockServer::start().await;
        let body = make_response(serde_json::json!([
            {"type": "node", "id": 100, "lat": 45.55, "lon": -73.55,
             "tags": {"leisure": "swimming_pool", "access": "private"}},
            {"type": "node", "id": 101, "lat": 45.56, "lon": -73.55,
             "tags": {"leisure": "swimming_pool"}},
        ]));
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let cfg = sample_config(
            "groups:\n    leisure:\n        - leisure=*\n\
             exceptions:\n    - all:\n        - leisure=swimming_pool\n        - access=private\n",
        );
        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let pois = client.fetch_pois(&sample_bbox(), &cfg).await.unwrap();
        assert_eq!(pois.len(), 1, "private pool must be dropped");
        assert_eq!(pois[0].osm_id, 101);
    }

    #[tokio::test]
    async fn drops_elements_without_center_or_matching_group() {
        let server = MockServer::start().await;
        let body = make_response(serde_json::json!([
            // No lat/lon and no center -> drop.
            {"type": "way", "id": 1, "tags": {"shop": "bakery"}},
            // Tags match no group -> drop.
            {"type": "node", "id": 2, "lat": 45.55, "lon": -73.55,
             "tags": {"amenity": "cafe"}},
            // Valid.
            {"type": "node", "id": 3, "lat": 45.56, "lon": -73.54,
             "tags": {"shop": "supermarket"}},
        ]));
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let cfg = sample_config("groups:\n    shops:\n        - shop=*\n");
        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let pois = client.fetch_pois(&sample_bbox(), &cfg).await.unwrap();
        assert_eq!(pois.len(), 1);
        assert_eq!(pois[0].osm_id, 3);
    }

    #[tokio::test]
    async fn empty_elements_produces_empty_vec() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(make_response(serde_json::json!([]))),
            )
            .mount(&server)
            .await;

        let cfg = sample_config("groups:\n    shops:\n        - shop=*\n");
        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let pois = client.fetch_pois(&sample_bbox(), &cfg).await.unwrap();
        assert!(pois.is_empty());
    }

    #[tokio::test]
    async fn non_2xx_surfaces_http_error_with_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(504).set_body_string("rate limited"))
            .mount(&server)
            .await;

        let cfg = sample_config("groups:\n    shops:\n        - shop=*\n");
        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let err = client
            .fetch_pois(&sample_bbox(), &cfg)
            .await
            .expect_err("504 must surface as an error");
        match err {
            OverpassError::Http { status, body } => {
                assert_eq!(status, 504);
                assert!(body.contains("rate limited"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn malformed_json_surfaces_decode_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_string("{not: json"),
            )
            .mount(&server)
            .await;

        let cfg = sample_config("groups:\n    shops:\n        - shop=*\n");
        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let err = client
            .fetch_pois(&sample_bbox(), &cfg)
            .await
            .expect_err("malformed JSON must surface as an error");
        assert!(matches!(err, OverpassError::Decode(_)), "got {err:?}");
    }

    #[test]
    fn parse_osm_ref_accepts_spaces() {
        assert_eq!(parse_osm_ref("node/1").unwrap(), (OsmType::Node, 1));
        assert_eq!(parse_osm_ref("  way / 99 ").unwrap(), (OsmType::Way, 99));
        assert!(parse_osm_ref("nope").is_err());
    }

    #[test]
    fn build_osm_anchor_query_targets_one_element() {
        let q = build_osm_anchor_query(OsmType::Relation, 99);
        assert!(q.contains("relation(99)"));
        assert!(q.contains("out center tags;"));
    }

    #[tokio::test]
    async fn anchor_center_picks_matching_element_not_first_in_array() {
        let server = MockServer::start().await;
        // Decoy first: would be wrong if we still used `.elements.into_iter().next()`.
        let body = make_response(serde_json::json!([
            {
                "type": "node",
                "id": 999,
                "lat": 35.0,
                "lon": 105.0,
                "tags": {}
            },
            {
                "type": "relation",
                "id": 3437968,
                "center": {"lat": 45.5055962, "lon": -73.6148766},
                "tags": {"name": "Université de Montréal"}
            },
        ]));
        Mock::given(method("POST"))
            .and(path("/api/interpreter"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let (center, tags) = client
            .fetch_osm_anchor_center(OsmType::Relation, 3437968)
            .await
            .unwrap();
        assert!(
            (center[0] + 73.6148766).abs() < 1e-6,
            "expected Montréal lon, got {center:?}"
        );
        assert!(
            (center[1] - 45.5055962).abs() < 1e-6,
            "expected Montréal lat, got {center:?}"
        );
        assert_eq!(tags.get("name").map(String::as_str), Some("Université de Montréal"));
    }

    #[tokio::test]
    async fn anchor_center_no_match_when_elements_are_other_objects() {
        let server = MockServer::start().await;
        let body = make_response(serde_json::json!([
            {"type": "node", "id": 1, "lat": 1.0, "lon": 2.0, "tags": {}},
        ]));
        Mock::given(method("POST"))
            .and(path("/api/interpreter"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let err = client
            .fetch_osm_anchor_center(OsmType::Relation, 3437968)
            .await
            .expect_err("wrong type/id must yield NoOsmElement");
        assert!(matches!(err, OverpassError::NoOsmElement), "got {err:?}");
    }
}
