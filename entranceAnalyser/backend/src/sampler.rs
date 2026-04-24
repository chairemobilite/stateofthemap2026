//! Uniform sampling from a pre-computed `EAGD` grid file.
//!
//! Wraps [`crate::grid::GridFile`] and exposes a single `sample()` method
//! that draws a random inhabited cell and decorates it with the derived
//! fields the HTTP API needs:
//!
//! * `density_per_km2` — `cell.pop / cell_size_km²`
//! * `max_density_ratio` — `density_per_km2 / max_density_per_km2_in_grid`
//!
//! `Sampler` is `Send + Sync`, immutable after construction, so it lives
//! in the Axum app state behind an `Arc` and serves any number of
//! concurrent `/api/bbox/random` requests with no locking.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::Path;

use rand::seq::IndexedRandom;

use crate::grid::{Cell, GridFile};

/// A single sampled grid cell with its derived population statistics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SampledCell {
    pub cell: Cell,
    pub density_per_km2: f64,
    pub max_density_ratio: f64,
}

#[derive(Debug)]
pub struct Sampler {
    grid: GridFile,
    cell_area_km2: f64,
    max_density_per_km2: f64,
}

impl Sampler {
    /// Wrap an in-memory grid. Empty grids are rejected — sampling them
    /// would be undefined.
    pub fn new(grid: GridFile) -> Result<Self, &'static str> {
        if grid.cells.is_empty() {
            return Err("cannot sample from an empty grid");
        }
        let cell_area_km2 = grid.cell_area_km2();
        let max_density_per_km2 = grid.max_density_per_km2();
        Ok(Self { grid, cell_area_km2, max_density_per_km2 })
    }

    /// Load a grid file from disk and wrap it.
    pub fn from_path(path: &Path) -> io::Result<Self> {
        let grid = GridFile::read_from(BufReader::new(File::open(path)?))?;
        Self::new(grid).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn cell_size_km(&self) -> u32 {
        self.grid.cell_size_km
    }

    pub fn cell_count(&self) -> usize {
        self.grid.cells.len()
    }

    pub fn max_density_per_km2(&self) -> f64 {
        self.max_density_per_km2
    }

    /// Draw one cell uniformly at random.
    pub fn sample(&self) -> SampledCell {
        let cell = *self
            .grid
            .cells
            .choose(&mut rand::rng())
            .expect("non-empty grid (checked in `new`)");
        self.decorate(cell)
    }

    fn decorate(&self, cell: Cell) -> SampledCell {
        let density_per_km2 = cell.pop as f64 / self.cell_area_km2;
        let max_density_ratio = if self.max_density_per_km2 > 0.0 {
            density_per_km2 / self.max_density_per_km2
        } else {
            0.0
        };
        SampledCell { cell, density_per_km2, max_density_ratio }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    fn grid(cell_size_km: u32, pops: &[f32]) -> GridFile {
        let cells = pops
            .iter()
            .enumerate()
            .map(|(i, &pop)| Cell { lat: i as f32, lon: -(i as f32), pop })
            .collect();
        GridFile::new(cell_size_km, 2020, cells)
    }

    #[test]
    fn empty_grid_is_rejected() {
        let g = GridFile::new(10, 2020, Vec::new());
        assert!(Sampler::new(g).is_err());
    }

    #[rstest]
    #[case(1, 100.0)]    // 1 km cell, 100 people → 100 / km²
    #[case(2, 25.0)]     // 2 km cell (4 km²), 100 people → 25 / km²
    #[case(10, 1.0)]     // 10 km cell (100 km²), 100 people → 1 / km²
    fn density_uses_cell_area(#[case] cell_size_km: u32, #[case] expected: f64) {
        let s = Sampler::new(grid(cell_size_km, &[100.0])).unwrap();
        let drawn = s.sample();
        assert!((drawn.density_per_km2 - expected).abs() < 1e-9);
    }

    #[test]
    fn ratio_is_one_for_max_cell_and_in_zero_one_otherwise() {
        let s = Sampler::new(grid(10, &[10.0, 200.0, 50.0])).unwrap();
        // The grid only has three cells, so over enough draws we hit each.
        let mut max_ratio: f64 = 0.0;
        let mut min_ratio = f64::INFINITY;
        for _ in 0..2000 {
            let r = s.sample().max_density_ratio;
            assert!((0.0..=1.0).contains(&r), "ratio out of range: {r}");
            max_ratio = max_ratio.max(r);
            min_ratio = min_ratio.min(r);
        }
        assert!((max_ratio - 1.0).abs() < 1e-9);
        // 10 / 200 = 0.05
        assert!((min_ratio - 0.05).abs() < 1e-9);
    }

    #[test]
    fn sample_returns_one_of_the_known_cells() {
        let s = Sampler::new(grid(10, &[1.0, 2.0, 3.0])).unwrap();
        let drawn = s.sample();
        let pops = [1.0, 2.0, 3.0];
        assert!(pops.contains(&drawn.cell.pop));
    }
}
