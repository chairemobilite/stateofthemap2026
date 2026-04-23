//! Entrance Analyser backend — binary entry point.
//!
//! This commit only ships the core data model: random 10 × 10 km bbox
//! generation and atomic JSON storage for kept boxes. The axum HTTP layer
//! is added in the next commit.

mod bbox;
mod storage;

fn main() {
    // Smoke test the two core modules. Printing a fresh random bbox and the
    // resolved storage path is enough to confirm everything compiles and
    // wires together before the HTTP layer lands.
    let sample = bbox::random_bbox();
    let store = storage::JsonStore::new("data/kept_bboxes.json");
    let kept_so_far = store.load().map(|f| f.kept_bboxes.len()).unwrap_or(0);
    println!(
        "entrance-analyser-backend: core scaffold — sample bbox id = {}, \
         currently {} kept bbox(es) on disk",
        sample.id, kept_so_far,
    );
}
