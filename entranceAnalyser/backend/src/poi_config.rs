//! Loader for `config/poi_tags.yml`.
//!
//! The YAML shape is one top-level `groups` map (where each entry
//! names a semantic category and lists raw OSM tag expressions in
//! `key=value` form, with `*` matching any value) plus an optional
//! top-level `exceptions` list of the same expression syntax. A
//! feature is a POI when it matches at least one group expression
//! **and** matches no exception. Parsing happens once at load time so
//! the hot path ([`PoiTagConfig::group_for_tags`]) is pure lookup.
//!
//! Exceptions are also consumed by `overpass::build_query`, which
//! turns them into per-line `!=` negations on the QL so excluded
//! features never come back from Overpass. The client-side
//! [`PoiTagConfig::group_for_tags`] still applies as a safety net
//! and stays the canonical contract.
//!
//! ```yaml
//! groups:
//!     shops:
//!         - shop=*
//!     public_transport:
//!         - highway=bus_stop
//!         - railway=tram_stop
//! exceptions:
//!     - shop=vacant
//!     - shop=no
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde::Deserialize;

/// A single OSM tag expression, pre-parsed into its key and value parts.
///
/// `value == None` means wildcard (`key=*`): the expression matches any
/// feature that carries a value for `key`, regardless of what that
/// value is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagExpr {
    pub key: String,
    /// `None` ≡ wildcard.
    pub value: Option<String>,
}

impl TagExpr {
    /// Parse an expression of the form `key=value` or `key=*`. Leading
    /// and trailing whitespace on either side of `=` is tolerated.
    ///
    /// @param raw - The raw expression string straight from YAML.
    /// @returns The parsed expression, or an error carrying the input.
    pub fn parse(raw: &str) -> Result<Self, BadExpression> {
        let (key, value) = raw
            .split_once('=')
            .ok_or_else(|| BadExpression::new(raw, "expected `key=value` or `key=*`"))?;
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() {
            return Err(BadExpression::new(raw, "key is empty"));
        }
        if value.is_empty() {
            return Err(BadExpression::new(raw, "value is empty"));
        }
        Ok(TagExpr {
            key: key.to_string(),
            value: if value == "*" {
                None
            } else {
                Some(value.to_string())
            },
        })
    }

    /// Return `true` when `tags` carries a matching value for this
    /// expression.
    pub fn matches(&self, tags: &BTreeMap<String, String>) -> bool {
        let Some(actual) = tags.get(&self.key) else {
            return false;
        };
        match &self.value {
            None => true,
            Some(expected) => expected == actual,
        }
    }
}

/// Parsed `poi_tags.yml` content. Ordering of groups matches the YAML
/// file (via `IndexMap`) so callers that iterate groups get a stable,
/// human-friendly ordering without sorting.
#[derive(Debug, Clone)]
pub struct PoiTagConfig {
    pub groups: IndexMap<String, Vec<TagExpr>>,
    /// Tag expressions that disqualify a feature from being a POI even
    /// when it matched a group. Empty when the YAML omits the
    /// `exceptions:` section.
    pub exceptions: Vec<TagExpr>,
}

impl PoiTagConfig {
    /// Read and parse a YAML file from disk. Returns a
    /// [`ConfigError`] with enough context for an operator to find the
    /// offending line.
    pub fn load_from_path(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let path = path.as_ref().to_path_buf();
        let body = fs::read_to_string(&path).map_err(|source| ConfigError::Io {
            path: path.clone(),
            source,
        })?;
        Self::from_yaml_str(&body).map_err(|source| match source {
            ParseError::Yaml(e) => ConfigError::Yaml {
                path: path.clone(),
                source: e,
            },
            ParseError::NoGroups => ConfigError::NoGroups { path: path.clone() },
            ParseError::EmptyGroup { group } => ConfigError::EmptyGroup {
                path: path.clone(),
                group,
            },
            ParseError::Bad { group, source } => ConfigError::BadExpression {
                path: path.clone(),
                group,
                source,
            },
            ParseError::BadException { source } => ConfigError::BadException {
                path: path.clone(),
                source,
            },
        })
    }

    /// Parse a YAML document already held in memory. Mostly useful for
    /// tests; [`load_from_path`](Self::load_from_path) is the normal
    /// entry point in production.
    pub fn from_yaml_str(body: &str) -> Result<Self, ParseError> {
        let raw: RawConfig = serde_yaml::from_str(body).map_err(ParseError::Yaml)?;
        if raw.groups.is_empty() {
            return Err(ParseError::NoGroups);
        }
        let mut groups = IndexMap::with_capacity(raw.groups.len());
        for (name, exprs) in raw.groups {
            if exprs.is_empty() {
                return Err(ParseError::EmptyGroup { group: name });
            }
            let parsed: Result<Vec<_>, _> = exprs.iter().map(|s| TagExpr::parse(s)).collect();
            let parsed = parsed.map_err(|source| ParseError::Bad {
                group: name.clone(),
                source,
            })?;
            groups.insert(name, parsed);
        }
        let exceptions: Result<Vec<_>, _> =
            raw.exceptions.iter().map(|s| TagExpr::parse(s)).collect();
        let exceptions = exceptions.map_err(|source| ParseError::BadException { source })?;
        Ok(PoiTagConfig { groups, exceptions })
    }

    /// Return the first group whose tag expressions match `tags`,
    /// unless `tags` also matches any expression in `exceptions` — in
    /// which case we treat the feature as a non-POI and return `None`.
    /// When more than one group matches, the YAML declaration order
    /// wins, which is why we preserve it via `IndexMap`.
    pub fn group_for_tags(&self, tags: &BTreeMap<String, String>) -> Option<&str> {
        if self.is_exception(tags) {
            return None;
        }
        for (name, exprs) in &self.groups {
            if exprs.iter().any(|e| e.matches(tags)) {
                return Some(name.as_str());
            }
        }
        None
    }

    /// `true` when at least one expression in `exceptions` matches
    /// `tags`. Public so callers can distinguish "not a POI" (no group
    /// matched) from "explicitly excluded" if they ever need the
    /// difference.
    pub fn is_exception(&self, tags: &BTreeMap<String, String>) -> bool {
        self.exceptions.iter().any(|e| e.matches(tags))
    }
}

#[derive(Debug, Deserialize)]
struct RawConfig {
    groups: IndexMap<String, Vec<String>>,
    #[serde(default)]
    exceptions: Vec<String>,
}

/// Context-free parse failure; surfaced wrapped by [`ConfigError`]
/// when the caller also knows the file path.
#[derive(Debug)]
pub enum ParseError {
    Yaml(serde_yaml::Error),
    NoGroups,
    EmptyGroup {
        group: String,
    },
    Bad {
        group: String,
        source: BadExpression,
    },
    BadException {
        source: BadExpression,
    },
}

/// Single malformed expression (`shop` without `=`, empty value, etc).
#[derive(Debug, Clone)]
pub struct BadExpression {
    pub raw: String,
    pub reason: String,
}

impl BadExpression {
    fn new(raw: &str, reason: &str) -> Self {
        Self {
            raw: raw.to_string(),
            reason: reason.to_string(),
        }
    }
}

impl std::fmt::Display for BadExpression {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.raw, self.reason)
    }
}

impl std::error::Error for BadExpression {}

/// Failure mode for [`PoiTagConfig::load_from_path`]. Carries the file
/// path on every variant so the message tells the operator which YAML
/// to fix.
#[derive(Debug)]
pub enum ConfigError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Yaml {
        path: PathBuf,
        source: serde_yaml::Error,
    },
    NoGroups {
        path: PathBuf,
    },
    EmptyGroup {
        path: PathBuf,
        group: String,
    },
    BadExpression {
        path: PathBuf,
        group: String,
        source: BadExpression,
    },
    BadException {
        path: PathBuf,
        source: BadExpression,
    },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "reading {path:?}: {source}"),
            Self::Yaml { path, source } => write!(f, "parsing {path:?}: {source}"),
            Self::NoGroups { path } => {
                write!(f, "{path:?} declares no groups (need at least one)")
            }
            Self::EmptyGroup { path, group } => {
                write!(f, "group {group:?} in {path:?} has no tag expressions")
            }
            Self::BadExpression {
                path,
                group,
                source,
            } => write!(f, "bad expression in group {group:?} ({path:?}): {source}"),
            Self::BadException { path, source } => {
                write!(f, "bad expression in `exceptions` ({path:?}): {source}")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    fn tags_from(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[rstest]
    #[case("shop=*", "shop", None)]
    #[case("shop=supermarket", "shop", Some("supermarket"))]
    #[case("  shop   =   *  ", "shop", None)]
    #[case("railway=tram_stop", "railway", Some("tram_stop"))]
    fn parses_valid_tag_expressions(
        #[case] raw: &str,
        #[case] key: &str,
        #[case] value: Option<&str>,
    ) {
        let parsed = TagExpr::parse(raw).unwrap();
        assert_eq!(parsed.key, key);
        assert_eq!(parsed.value.as_deref(), value);
    }

    #[rstest]
    #[case("shop")]
    #[case("=value")]
    #[case("shop=")]
    #[case(" = ")]
    fn rejects_malformed_tag_expressions(#[case] raw: &str) {
        assert!(TagExpr::parse(raw).is_err(), "should reject {raw:?}");
    }

    #[test]
    fn wildcard_matches_any_value_for_key() {
        let expr = TagExpr::parse("shop=*").unwrap();
        assert!(expr.matches(&tags_from(&[("shop", "bakery")])));
        assert!(expr.matches(&tags_from(&[("shop", "supermarket")])));
        assert!(!expr.matches(&tags_from(&[("amenity", "cafe")])));
    }

    #[test]
    fn exact_match_requires_value_equality() {
        let expr = TagExpr::parse("highway=bus_stop").unwrap();
        assert!(expr.matches(&tags_from(&[("highway", "bus_stop")])));
        assert!(!expr.matches(&tags_from(&[("highway", "primary")])));
        assert!(!expr.matches(&tags_from(&[("amenity", "bus_stop")])));
    }

    #[test]
    fn parses_two_groups_preserving_yaml_order() {
        let yaml = r#"
groups:
    shops:
        - shop=*
    public_transport:
        - highway=bus_stop
        - railway=tram_stop
"#;
        let cfg = PoiTagConfig::from_yaml_str(yaml).unwrap();
        let names: Vec<_> = cfg.groups.keys().cloned().collect();
        assert_eq!(names, ["shops", "public_transport"]);
        assert_eq!(cfg.groups["shops"].len(), 1);
        assert_eq!(cfg.groups["public_transport"].len(), 2);
        assert!(
            cfg.exceptions.is_empty(),
            "missing `exceptions:` defaults to empty"
        );
    }

    #[rstest]
    #[case("groups: {}", "NoGroups")]
    #[case("groups:\n    shops: []", "EmptyGroup")]
    #[case("groups:\n    shops:\n        - not-a-tag-expr", "Bad")]
    #[case(
        "groups:\n    shops:\n        - shop=*\nexceptions:\n    - not-a-tag-expr",
        "BadException"
    )]
    fn rejects_invalid_yaml(#[case] body: &str, #[case] variant: &str) {
        let err = PoiTagConfig::from_yaml_str(body).unwrap_err();
        let label = match err {
            ParseError::NoGroups => "NoGroups",
            ParseError::EmptyGroup { .. } => "EmptyGroup",
            ParseError::Bad { .. } => "Bad",
            ParseError::BadException { .. } => "BadException",
            ParseError::Yaml(_) => "Yaml",
        };
        assert_eq!(label, variant);
    }

    #[test]
    fn group_for_tags_respects_declaration_order() {
        // `shops` declared before `food`; a feature that matches both
        // must resolve to `shops`.
        let cfg = PoiTagConfig::from_yaml_str(
            r#"
groups:
    shops:
        - shop=*
    food:
        - shop=bakery
"#,
        )
        .unwrap();
        let tags = tags_from(&[("shop", "bakery")]);
        assert_eq!(cfg.group_for_tags(&tags), Some("shops"));

        let tags = tags_from(&[("amenity", "restaurant")]);
        assert_eq!(cfg.group_for_tags(&tags), None);
    }

    #[test]
    fn parses_exceptions_list() {
        let cfg = PoiTagConfig::from_yaml_str(
            r#"
groups:
    shops:
        - shop=*
exceptions:
    - shop=vacant
    - amenity=bench
"#,
        )
        .unwrap();
        assert_eq!(cfg.exceptions.len(), 2);
        assert_eq!(cfg.exceptions[0].key, "shop");
        assert_eq!(cfg.exceptions[0].value.as_deref(), Some("vacant"));
        assert_eq!(cfg.exceptions[1].key, "amenity");
        assert_eq!(cfg.exceptions[1].value.as_deref(), Some("bench"));
    }

    #[test]
    fn exception_overrides_group_match() {
        let cfg = PoiTagConfig::from_yaml_str(
            r#"
groups:
    shops:
        - shop=*
exceptions:
    - shop=vacant
"#,
        )
        .unwrap();
        // Real shop -> matches group.
        let real = tags_from(&[("shop", "bakery"), ("name", "Bakery")]);
        assert_eq!(cfg.group_for_tags(&real), Some("shops"));
        assert!(!cfg.is_exception(&real));

        // Vacant storefront -> excepted, dropped from POI set.
        let vacant = tags_from(&[("shop", "vacant")]);
        assert_eq!(cfg.group_for_tags(&vacant), None);
        assert!(cfg.is_exception(&vacant));
    }

    #[test]
    fn exception_with_wildcard_matches_any_value_for_key() {
        let cfg = PoiTagConfig::from_yaml_str(
            r#"
groups:
    amenities:
        - amenity=*
exceptions:
    - amenity=*
"#,
        )
        .unwrap();
        let tags = tags_from(&[("amenity", "cafe")]);
        // Group matches AND exception matches (wildcard); exception wins.
        assert_eq!(cfg.group_for_tags(&tags), None);
    }

    #[test]
    fn load_from_path_reports_missing_file() {
        let err = PoiTagConfig::load_from_path("/nonexistent/poi_tags.yml").unwrap_err();
        assert!(matches!(err, ConfigError::Io { .. }), "got {err:?}");
    }

    #[test]
    fn load_from_path_parses_the_real_shipped_yaml() {
        // Smoke test: the YAML the repository ships with must always
        // be loadable. Catches accidental schema drift between the
        // file and the parser.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("config")
            .join("poi_tags.yml");
        let cfg = PoiTagConfig::load_from_path(&path)
            .unwrap_or_else(|e| panic!("shipped YAML {path:?} must parse: {e}"));
        assert!(!cfg.groups.is_empty(), "shipped YAML declared no groups");
        // Every shipped exception must be drop-only (i.e. it must not
        // also be one of the group's exact expressions, because that
        // would make the group entry dead code). Cheap invariant for
        // catching authoring mistakes during YAML edits.
        for exc in &cfg.exceptions {
            for exprs in cfg.groups.values() {
                let conflict = exprs.iter().any(|g| g == exc);
                assert!(
                    !conflict,
                    "exception {exc:?} duplicates a group expression — \
                     either drop the exception or remove it from the group",
                );
            }
        }
    }
}
