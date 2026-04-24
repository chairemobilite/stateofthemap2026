//! Shared library code for the entrance-analyser backend.
//!
//! Both the HTTP server (`src/main.rs`) and the offline build-grid binary
//! (`src/bin/build_grid.rs`) link against this crate.

pub mod aggregate;
pub mod api;
pub mod bbox;
pub mod geotiff_pop;
pub mod grid;
pub mod mollweide;
pub mod sampler;
pub mod storage;
