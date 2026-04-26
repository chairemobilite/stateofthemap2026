//! Overpass query for the per-POI focus map.
//!
//! Given a picked POI and a radius (in metres), query Overpass for
//! every `building=*` way and every `entrance=*` node within the
//! buffer, and return them as two pre-formed GeoJSON
//! `FeatureCollection`s ready to drop into MapLibre `geojson` sources.
//!
//! ## Scope decisions
//!
//! * **Ways for buildings, not relations.** The vast majority of OSM
//!   buildings sit on a single closed way; multi-polygon `building`
//!   relations are rare and decoding their member geometries from
//!   `out geom` is significantly more involved. A first-cut focus map
//!   that under-counts the few multi-polygon buildings is acceptable;
//!   we can lift the restriction once it bites.
//! * **`entrance=*` nodes only**, not `door=*`. The mapping question is
//!   "does this building have its entrances mapped?", not "does any
//!   sub-feature have a door tag". Including `door=*` would inflate the
//!   coverage signal with interior doors and obscure what we want to
//!   measure.
//! * **Radius driven by the caller.** The handler resolves the
//!   buffer from `?radius_m=` (per-request override) or
//!   `POI_FOCUS_RADIUS_M` (server default, 150 m) and passes it
//!   through, so an operator can widen / shrink either globally or
//!   for a single POI without touching code. The handler also
//!   short-circuits the cache only when the cached radius matches
//!   the requested one.
//!
//! The QL builder is public so handler-level tests can assert on its
//! output without a network round-trip.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::overpass::{OsmType, OverpassClient, OverpassError};

/// Matches the `[timeout:N]` setting embedded in every QL query.
/// Mirrors the value used by [`crate::overpass::build_query`].
const OVERPASS_QUERY_TIMEOUT_S: u32 = 25;

/// Result of one focus query: the picked POI's identity (echoed for
/// the caller's convenience) and the two GeoJSON feature collections.
///
/// Both collections are valid GeoJSON: the frontend can pass them
/// straight to a MapLibre `addSource({ type: 'geojson', data })`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoiFocusResult {
    /// `[lon, lat]` — GeoJSON order, the centre Overpass anchored on.
    pub center: [f64; 2],
    /// Effective radius (m) used by the `around:` filter. Echoed so
    /// the frontend can draw the buffer ring without having to know
    /// the server config.
    pub radius_m: u32,
    pub buildings: FeatureCollection,
    pub entrances: FeatureCollection,
}

/// Minimal GeoJSON `FeatureCollection`. We reimplement instead of
/// pulling in a `geojson` crate because we only need two geometry
/// kinds (Point + Polygon) and a flat string-typed properties map.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureCollection {
    #[serde(rename = "type")]
    pub kind: FeatureCollectionType,
    pub features: Vec<Feature>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum FeatureCollectionType {
    FeatureCollection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feature {
    #[serde(rename = "type")]
    pub kind: FeatureType,
    /// `"node/123"`, `"way/456"`, `"relation/789"` — stable across
    /// re-fetches, so the frontend can use it as a MapLibre feature id.
    pub id: String,
    pub geometry: Geometry,
    pub properties: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum FeatureType {
    Feature,
}

/// The two GeoJSON geometry kinds we emit. `Polygon` carries one
/// outer ring (no holes) — that's all `way[building]` produces.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Geometry {
    Point { coordinates: [f64; 2] },
    Polygon { coordinates: Vec<Vec<[f64; 2]>> },
}

/// Build the Overpass QL for one focus query.
///
/// `center` is `[lon, lat]` (GeoJSON order); `radius_m` is the
/// `around:` buffer in metres. Public so handler tests can assert on
/// the exact QL without hitting the network.
pub fn build_focus_query(center: [f64; 2], radius_m: u32) -> String {
    let [lon, lat] = center;
    format!(
        "[out:json][timeout:{t}];\n\
         (\n\
         \x20   way(around:{r},{lat},{lon})[\"building\"];\n\
         \x20   node(around:{r},{lat},{lon})[\"entrance\"];\n\
         );\n\
         out geom tags;\n",
        t = OVERPASS_QUERY_TIMEOUT_S,
        r = radius_m,
    )
}

/// Run the focus query and convert the raw Overpass payload into
/// GeoJSON. Reuses the configured [`OverpassClient`] so the URL and
/// `reqwest` settings stay centralised.
pub async fn fetch_focus(
    client: &OverpassClient,
    center: [f64; 2],
    radius_m: u32,
) -> Result<PoiFocusResult, OverpassError> {
    let ql = build_focus_query(center, radius_m);
    let raw: RawResponse = client.execute_ql(&ql).await?;
    Ok(into_focus_result(raw, center, radius_m))
}

/// Pure transform: raw Overpass payload → typed GeoJSON result.
/// Split out so unit tests can exercise the conversion without a
/// mock HTTP server.
fn into_focus_result(raw: RawResponse, center: [f64; 2], radius_m: u32) -> PoiFocusResult {
    let mut buildings = Vec::new();
    let mut entrances = Vec::new();
    for el in raw.elements {
        let osm_type = match OsmType::from_overpass(&el.osm_type) {
            Some(t) => t,
            None => continue,
        };
        match osm_type {
            OsmType::Way => {
                if let Some(feat) = el.into_polygon_feature() {
                    buildings.push(feat);
                }
            }
            OsmType::Node => {
                if let Some(feat) = el.into_point_feature() {
                    entrances.push(feat);
                }
            }
            // Relations aren't queried (see module docs); ignore.
            OsmType::Relation => {}
        }
    }
    PoiFocusResult {
        center,
        radius_m,
        buildings: FeatureCollection {
            kind: FeatureCollectionType::FeatureCollection,
            features: buildings,
        },
        entrances: FeatureCollection {
            kind: FeatureCollectionType::FeatureCollection,
            features: entrances,
        },
    }
}

// ---------- raw Overpass response (crate-private) ----------

#[derive(Debug, Deserialize)]
struct RawResponse {
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
    /// `out geom` emits the way's full vertex list here.
    #[serde(default)]
    geometry: Option<Vec<RawLatLon>>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct RawLatLon {
    lat: f64,
    lon: f64,
}

impl RawElement {
    fn into_point_feature(self) -> Option<Feature> {
        let lat = self.lat?;
        let lon = self.lon?;
        Some(Feature {
            kind: FeatureType::Feature,
            id: format!("node/{}", self.id),
            geometry: Geometry::Point {
                coordinates: [lon, lat],
            },
            properties: self.tags,
        })
    }

    fn into_polygon_feature(self) -> Option<Feature> {
        let geometry = self.geometry?;
        // Overpass needs at least 3 distinct vertices for a sensible
        // polygon. Anything shorter is malformed; drop it.
        if geometry.len() < 3 {
            return None;
        }
        let mut ring: Vec<[f64; 2]> = geometry.iter().map(|p| [p.lon, p.lat]).collect();
        // GeoJSON polygons require a closed ring (first == last).
        // Overpass's `out geom` emits ways verbatim, so closed-by-author
        // ways already match; open ones (legitimate when an outline
        // wraps around) need an explicit closing copy.
        if ring.first() != ring.last() {
            ring.push(*ring.first().expect("len >= 3 above"));
        }
        Some(Feature {
            kind: FeatureType::Feature,
            id: format!("way/{}", self.id),
            geometry: Geometry::Polygon {
                coordinates: vec![ring],
            },
            properties: self.tags,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn query_uses_around_filter_with_radius_lat_lon() {
        let ql = build_focus_query([-73.55, 45.55], 150);
        // Overpass `around:` syntax is `radius,lat,lon` — order matters.
        assert!(
            ql.contains("(around:150,45.55,-73.55)"),
            "wrong around filter: {ql}",
        );
        assert!(
            ql.contains("way(around:150,45.55,-73.55)[\"building\"]"),
            "missing building line: {ql}",
        );
        assert!(
            ql.contains("node(around:150,45.55,-73.55)[\"entrance\"]"),
            "missing entrance line: {ql}",
        );
        assert!(ql.contains("out geom tags;"), "missing out clause: {ql}");
    }

    #[test]
    fn query_threads_radius_through_verbatim() {
        let ql = build_focus_query([0.0, 0.0], 42);
        assert!(ql.contains("(around:42,"), "radius not threaded: {ql}");
    }

    #[test]
    fn polygon_feature_closes_open_ring() {
        let raw = RawResponse {
            elements: vec![RawElement {
                osm_type: "way".into(),
                id: 100,
                lat: None,
                lon: None,
                geometry: Some(vec![
                    RawLatLon { lat: 0.0, lon: 0.0 },
                    RawLatLon { lat: 0.0, lon: 1.0 },
                    RawLatLon { lat: 1.0, lon: 1.0 },
                    RawLatLon { lat: 1.0, lon: 0.0 },
                ]),
                tags: BTreeMap::from([("building".into(), "yes".into())]),
            }],
        };
        let result = into_focus_result(raw, [0.5, 0.5], 100);
        assert_eq!(result.buildings.features.len(), 1);
        let feat = &result.buildings.features[0];
        assert_eq!(feat.id, "way/100");
        let Geometry::Polygon { coordinates } = &feat.geometry else {
            panic!("expected Polygon, got {:?}", feat.geometry);
        };
        let ring = &coordinates[0];
        assert_eq!(ring.len(), 5, "open ring must be closed: {ring:?}");
        assert_eq!(ring.first(), ring.last(), "ring must close on itself");
    }

    #[test]
    fn polygon_feature_keeps_already_closed_ring_intact() {
        let raw = RawResponse {
            elements: vec![RawElement {
                osm_type: "way".into(),
                id: 200,
                lat: None,
                lon: None,
                geometry: Some(vec![
                    RawLatLon { lat: 0.0, lon: 0.0 },
                    RawLatLon { lat: 0.0, lon: 1.0 },
                    RawLatLon { lat: 1.0, lon: 1.0 },
                    RawLatLon { lat: 0.0, lon: 0.0 },
                ]),
                tags: BTreeMap::new(),
            }],
        };
        let result = into_focus_result(raw, [0.0, 0.0], 100);
        let Geometry::Polygon { coordinates } = &result.buildings.features[0].geometry else {
            panic!("expected Polygon");
        };
        assert_eq!(coordinates[0].len(), 4, "closed ring must not be re-closed");
    }

    #[test]
    fn dropped_when_geometry_too_short_or_missing() {
        let raw = RawResponse {
            elements: vec![
                RawElement {
                    osm_type: "way".into(),
                    id: 1,
                    lat: None,
                    lon: None,
                    geometry: None,
                    tags: BTreeMap::new(),
                },
                RawElement {
                    osm_type: "way".into(),
                    id: 2,
                    lat: None,
                    lon: None,
                    geometry: Some(vec![
                        RawLatLon { lat: 0.0, lon: 0.0 },
                        RawLatLon { lat: 0.0, lon: 1.0 },
                    ]),
                    tags: BTreeMap::new(),
                },
            ],
        };
        let result = into_focus_result(raw, [0.0, 0.0], 100);
        assert!(
            result.buildings.features.is_empty(),
            "ways without usable geometry must drop"
        );
    }

    #[test]
    fn entrance_node_becomes_point_feature_with_tags() {
        let raw = RawResponse {
            elements: vec![RawElement {
                osm_type: "node".into(),
                id: 999,
                lat: Some(45.55),
                lon: Some(-73.55),
                geometry: None,
                tags: BTreeMap::from([
                    ("entrance".into(), "main".into()),
                    ("wheelchair".into(), "yes".into()),
                ]),
            }],
        };
        let result = into_focus_result(raw, [-73.55, 45.55], 150);
        assert_eq!(result.entrances.features.len(), 1);
        let feat = &result.entrances.features[0];
        assert_eq!(feat.id, "node/999");
        match &feat.geometry {
            Geometry::Point { coordinates } => assert_eq!(coordinates, &[-73.55, 45.55]),
            other => panic!("expected Point, got {other:?}"),
        }
        assert_eq!(feat.properties.get("entrance"), Some(&"main".to_string()));
        assert_eq!(feat.properties.get("wheelchair"), Some(&"yes".to_string()),);
    }

    #[test]
    fn buildings_and_entrances_are_partitioned_by_osm_type() {
        let raw = RawResponse {
            elements: vec![
                RawElement {
                    osm_type: "way".into(),
                    id: 10,
                    lat: None,
                    lon: None,
                    geometry: Some(vec![
                        RawLatLon { lat: 0.0, lon: 0.0 },
                        RawLatLon { lat: 0.0, lon: 1.0 },
                        RawLatLon { lat: 1.0, lon: 1.0 },
                    ]),
                    tags: BTreeMap::new(),
                },
                RawElement {
                    osm_type: "node".into(),
                    id: 20,
                    lat: Some(0.5),
                    lon: Some(0.5),
                    geometry: None,
                    tags: BTreeMap::from([("entrance".into(), "yes".into())]),
                },
                // Sneaky: a node with a `building` tag would be wrong
                // OSM-wise, but we just route on osm_type, so it lands
                // in entrances. That's intentional — we don't second-
                // guess the upstream filter.
                RawElement {
                    osm_type: "node".into(),
                    id: 30,
                    lat: Some(0.6),
                    lon: Some(0.6),
                    geometry: None,
                    tags: BTreeMap::from([("building".into(), "yes".into())]),
                },
            ],
        };
        let result = into_focus_result(raw, [0.0, 0.0], 100);
        assert_eq!(result.buildings.features.len(), 1);
        assert_eq!(result.entrances.features.len(), 2);
    }

    #[test]
    fn empty_response_yields_empty_collections() {
        let raw = RawResponse { elements: vec![] };
        let result = into_focus_result(raw, [0.0, 0.0], 100);
        assert!(result.buildings.features.is_empty());
        assert!(result.entrances.features.is_empty());
        assert_eq!(result.center, [0.0, 0.0]);
        assert_eq!(result.radius_m, 100);
    }

    #[test]
    fn feature_collection_round_trips_to_geojson() {
        // The whole point of this module is producing wire-compatible
        // GeoJSON; assert the serialized shape at least once.
        let result = into_focus_result(
            RawResponse {
                elements: vec![RawElement {
                    osm_type: "node".into(),
                    id: 1,
                    lat: Some(45.0),
                    lon: Some(-73.0),
                    geometry: None,
                    tags: BTreeMap::from([("entrance".into(), "yes".into())]),
                }],
            },
            [0.0, 0.0],
            100,
        );
        let json = serde_json::to_value(&result.entrances).unwrap();
        assert_eq!(json["type"], "FeatureCollection");
        assert_eq!(json["features"][0]["type"], "Feature");
        assert_eq!(json["features"][0]["geometry"]["type"], "Point");
        assert_eq!(
            json["features"][0]["geometry"]["coordinates"],
            json!([-73.0, 45.0]),
        );
    }

    #[tokio::test]
    async fn fetch_focus_round_trips_overpass_response() {
        let server = MockServer::start().await;
        let body = json!({
            "version": 0.6,
            "generator": "Overpass API mock",
            "elements": [
                {
                    "type": "way",
                    "id": 1,
                    "geometry": [
                        {"lat": 0.0, "lon": 0.0},
                        {"lat": 0.0, "lon": 1.0},
                        {"lat": 1.0, "lon": 1.0},
                        {"lat": 0.0, "lon": 0.0}
                    ],
                    "tags": {"building": "yes"}
                },
                {
                    "type": "node",
                    "id": 2,
                    "lat": 0.5,
                    "lon": 0.5,
                    "tags": {"entrance": "main"}
                }
            ]
        });
        Mock::given(method("POST"))
            .and(path("/api/interpreter"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let result = fetch_focus(&client, [0.5, 0.5], 200).await.unwrap();

        assert_eq!(result.radius_m, 200);
        assert_eq!(result.center, [0.5, 0.5]);
        assert_eq!(result.buildings.features.len(), 1);
        assert_eq!(result.buildings.features[0].id, "way/1");
        assert_eq!(result.entrances.features.len(), 1);
        assert_eq!(result.entrances.features[0].id, "node/2");
    }

    #[tokio::test]
    async fn fetch_focus_propagates_overpass_http_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
            .mount(&server)
            .await;

        let client = OverpassClient::new(format!("{}/api/interpreter", server.uri()));
        let err = fetch_focus(&client, [0.0, 0.0], 100)
            .await
            .expect_err("429 must propagate");
        assert!(matches!(err, OverpassError::Http { status: 429, .. }));
    }
}
