/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Shared library code for the entrance-analyser backend.
//!
//! Both the HTTP server (`src/main.rs`) and the offline build-grid binary
//! (`src/bin/build_grid.rs`) link against this crate.

pub mod aggregate;
pub mod api;
pub mod bbox;
pub mod config;
pub mod db;
pub mod focus_measurements;
pub mod geotiff_pop;
pub mod lzw_transcode;
pub mod measurement_destination_warnings;
pub mod mollweide;
pub mod overpass;
pub mod poi_config;
pub mod poi_focus;
pub mod sampler;
pub mod storage;
