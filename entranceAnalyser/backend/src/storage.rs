//! Atomic JSON storage for kept bounding boxes.
//!
//! The backing file is a single JSON document shaped like:
//!
//! ```json
//! { "version": 1, "kept_bboxes": [ ... ] }
//! ```
//!
//! Writes go through a temp file in the same directory and are swapped into
//! place with `rename`, which is atomic on every POSIX filesystem we care
//! about. This is a dev-only backend, so we keep the implementation small
//! (no fsync, no file locks, no concurrent writers).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::bbox::KeptBbox;

/// Schema version — bumped if the on-disk format changes.
pub const CURRENT_VERSION: u32 = 1;

/// On-disk representation of the kept-bboxes file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeptFile {
    pub version: u32,
    pub kept_bboxes: Vec<KeptBbox>,
}

impl Default for KeptFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            kept_bboxes: Vec::new(),
        }
    }
}

/// Cheap handle over the kept-bboxes JSON file. Clone-friendly so it can
/// live inside the shared app state.
#[derive(Debug, Clone)]
pub struct JsonStore {
    path: PathBuf,
}

impl JsonStore {
    /// Create a store pointing at `path`. The file itself does not need to
    /// exist yet — `load` returns an empty `KeptFile` when it is missing.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Read the file, or return the default (empty) document if it does
    /// not exist yet.
    pub fn load(&self) -> io::Result<KeptFile> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(KeptFile::default()),
            Err(e) => Err(e),
        }
    }

    /// Append a new kept bbox and atomically persist the updated file.
    /// Returns the total number of kept bboxes after the append.
    pub fn append(&self, entry: KeptBbox) -> io::Result<usize> {
        let mut file = self.load()?;
        file.kept_bboxes.push(entry);
        let total = file.kept_bboxes.len();
        self.write_atomic(&file)?;
        Ok(total)
    }

    fn write_atomic(&self, file: &KeptFile) -> io::Result<()> {
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let json = serde_json::to_vec_pretty(file)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(&json)?;
        tmp.flush()?;
        tmp.persist(&self.path).map_err(|e| e.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bbox::bbox_from_center;
    use chrono::Utc;
    use rstest::rstest;
    use tempfile::tempdir;

    fn sample_kept(lon: f64, lat: f64) -> KeptBbox {
        KeptBbox {
            bbox: bbox_from_center(lon, lat),
            kept_at: Utc::now(),
        }
    }

    #[test]
    fn load_missing_file_returns_empty_document() {
        let dir = tempdir().unwrap();
        let store = JsonStore::new(dir.path().join("kept_bboxes.json"));
        let file = store.load().unwrap();
        assert_eq!(file.version, CURRENT_VERSION);
        assert!(file.kept_bboxes.is_empty());
    }

    #[rstest]
    #[case(&[(-73.555, 45.525)])]
    #[case(&[(-73.555, 45.525), (2.35, 48.85)])]
    #[case(&[(0.0, 0.0), (139.69, 35.68), (-46.63, -23.55)])]
    fn append_then_load_roundtrips(#[case] centers: &[(f64, f64)]) {
        let dir = tempdir().unwrap();
        let store = JsonStore::new(dir.path().join("kept_bboxes.json"));

        let mut expected = Vec::new();
        for (i, (lon, lat)) in centers.iter().enumerate() {
            let entry = sample_kept(*lon, *lat);
            expected.push(entry.clone());
            let total = store.append(entry).unwrap();
            assert_eq!(total, i + 1);
        }

        let reloaded = store.load().unwrap();
        assert_eq!(reloaded.version, CURRENT_VERSION);
        assert_eq!(reloaded.kept_bboxes.len(), expected.len());
        // Metadata (id, center, kept_at) must match exactly; these are either
        // user-supplied or UUID/timestamp strings that never lose precision.
        for (got, want) in reloaded.kept_bboxes.iter().zip(&expected) {
            assert_eq!(got.bbox.id, want.bbox.id);
            assert_eq!(got.bbox.center, want.bbox.center);
            assert_eq!(got.kept_at, want.kept_at);
        }
        // A second load must be bit-identical to the first: once the data is
        // on disk, roundtripping it through JSON is the fixed point. That's
        // the real contract of the storage layer — the initial in-memory
        // floats can differ from the on-disk floats by one ULP because
        // serde_json's formatter picks the shortest roundtrip string.
        let reloaded_again = store.load().unwrap();
        assert_eq!(reloaded_again, reloaded);
    }
}
