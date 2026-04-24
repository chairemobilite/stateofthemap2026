//! Compact binary file format for the pre-computed world population grid.
//!
//! The build-grid binary streams the GHS-POP raster, aggregates it into
//! `cell_size_km × cell_size_km` cells, drops the empty ones, and writes the
//! result here. The runtime backend memory-maps (well, reads) this file at
//! startup and samples from it.
//!
//! ## Layout (little-endian)
//!
//! ```text
//!   bytes  field
//!   ---------------------------------------------------
//!   0..4   magic        = b"EAGD"             (Entrance-Analyser GriD)
//!   4..6   version      = u16, currently 1
//!   6..10  cell_size_km = u32                 (1, 5, 10, ...)
//!   10..12 epoch        = u16                 (1975, ..., 2030)
//!   12..14 reserved     = u16, 0
//!   14..18 n_cells      = u32
//!   18..22 max_pop      = f32                 (population of the densest cell)
//!   22..   cells        = n_cells × Cell      (12 bytes each)
//! ```
//!
//! `Cell` is `(lat: f32, lon: f32, pop: f32)` — `f32` is more than enough
//! given the source raster's ~1 km native resolution and keeps the file
//! small (~12 MB at 10 km cells, ~200 MB at 1 km).

use std::io::{self, Read, Write};

/// A single inhabited grid cell.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    pub lat: f32,
    pub lon: f32,
    pub pop: f32,
}

/// Magic header bytes — also used by the build-grid binary to refuse to
/// overwrite a non-grid file.
pub const MAGIC: &[u8; 4] = b"EAGD";
/// Current on-disk format version.
pub const VERSION: u16 = 1;
const HEADER_LEN: usize = 22;
const CELL_LEN: usize = 12;

/// In-memory representation of the grid file.
#[derive(Debug, Clone, PartialEq)]
pub struct GridFile {
    pub cell_size_km: u32,
    pub epoch: u16,
    pub max_pop: f32,
    pub cells: Vec<Cell>,
}

impl GridFile {
    /// Build a `GridFile` from an iterator of cells. `max_pop` is computed
    /// from the cells (0.0 when empty).
    pub fn new(cell_size_km: u32, epoch: u16, cells: Vec<Cell>) -> Self {
        let max_pop = cells.iter().map(|c| c.pop).fold(0.0_f32, f32::max);
        Self { cell_size_km, epoch, max_pop, cells }
    }

    /// Cell area in square kilometres — `cell_size_km²`.
    pub fn cell_area_km2(&self) -> f64 {
        let s = self.cell_size_km as f64;
        s * s
    }

    /// Maximum population density observed anywhere in the grid, in
    /// people / km². Used to compute `max_density_ratio` on the wire.
    pub fn max_density_per_km2(&self) -> f64 {
        self.max_pop as f64 / self.cell_area_km2()
    }

    /// Serialize the grid into `writer`. Always writes `n_cells` cells
    /// regardless of population (the build step is responsible for any
    /// population filtering).
    pub fn write_to<W: Write>(&self, mut writer: W) -> io::Result<()> {
        writer.write_all(MAGIC)?;
        writer.write_all(&VERSION.to_le_bytes())?;
        writer.write_all(&self.cell_size_km.to_le_bytes())?;
        writer.write_all(&self.epoch.to_le_bytes())?;
        writer.write_all(&0_u16.to_le_bytes())?; // reserved
        let n = u32::try_from(self.cells.len()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "n_cells exceeds u32::MAX")
        })?;
        writer.write_all(&n.to_le_bytes())?;
        writer.write_all(&self.max_pop.to_le_bytes())?;
        let mut buf = [0_u8; CELL_LEN];
        for c in &self.cells {
            buf[0..4].copy_from_slice(&c.lat.to_le_bytes());
            buf[4..8].copy_from_slice(&c.lon.to_le_bytes());
            buf[8..12].copy_from_slice(&c.pop.to_le_bytes());
            writer.write_all(&buf)?;
        }
        Ok(())
    }

    /// Read a grid file from `reader`. Validates the magic bytes and version.
    pub fn read_from<R: Read>(mut reader: R) -> io::Result<Self> {
        let mut header = [0_u8; HEADER_LEN];
        reader.read_exact(&mut header)?;
        if &header[0..4] != MAGIC {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad magic bytes"));
        }
        let version = u16::from_le_bytes([header[4], header[5]]);
        if version != VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported grid version {version} (expected {VERSION})"),
            ));
        }
        let cell_size_km = u32::from_le_bytes(header[6..10].try_into().unwrap());
        let epoch = u16::from_le_bytes([header[10], header[11]]);
        // header[12..14] reserved
        let n_cells = u32::from_le_bytes(header[14..18].try_into().unwrap()) as usize;
        let max_pop = f32::from_le_bytes(header[18..22].try_into().unwrap());

        let mut cells = Vec::with_capacity(n_cells);
        let mut buf = [0_u8; CELL_LEN];
        for _ in 0..n_cells {
            reader.read_exact(&mut buf)?;
            cells.push(Cell {
                lat: f32::from_le_bytes(buf[0..4].try_into().unwrap()),
                lon: f32::from_le_bytes(buf[4..8].try_into().unwrap()),
                pop: f32::from_le_bytes(buf[8..12].try_into().unwrap()),
            });
        }
        Ok(Self { cell_size_km, epoch, max_pop, cells })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    fn sample_cells() -> Vec<Cell> {
        vec![
            Cell { lat: 48.86, lon: 2.35, pop: 1_900_000.0 },
            Cell { lat: -23.55, lon: -46.63, pop: 750_000.0 },
            Cell { lat: 35.68, lon: 139.69, pop: 2_400_000.0 },
        ]
    }

    #[rstest]
    #[case(1)]
    #[case(5)]
    #[case(10)]
    #[case(50)]
    fn roundtrip_preserves_grid(#[case] cell_size_km: u32) {
        let g = GridFile::new(cell_size_km, 2020, sample_cells());
        let mut buf = Vec::new();
        g.write_to(&mut buf).unwrap();
        let back = GridFile::read_from(buf.as_slice()).unwrap();
        assert_eq!(g, back);
        assert_eq!(back.max_pop, 2_400_000.0);
        assert_eq!(back.cell_area_km2(), (cell_size_km as f64).powi(2));
    }

    #[test]
    fn empty_grid_roundtrips() {
        let g = GridFile::new(10, 2020, Vec::new());
        let mut buf = Vec::new();
        g.write_to(&mut buf).unwrap();
        let back = GridFile::read_from(buf.as_slice()).unwrap();
        assert_eq!(back.cells.len(), 0);
        assert_eq!(back.max_pop, 0.0);
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = vec![0_u8; HEADER_LEN];
        bytes[0..4].copy_from_slice(b"NOPE");
        let err = GridFile::read_from(bytes.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_unknown_version() {
        let g = GridFile::new(10, 2020, sample_cells());
        let mut buf = Vec::new();
        g.write_to(&mut buf).unwrap();
        // Bump the version byte from 1 to 99.
        buf[4] = 99;
        let err = GridFile::read_from(buf.as_slice()).unwrap_err();
        assert!(err.to_string().contains("unsupported grid version 99"));
    }

    #[test]
    fn max_density_uses_cell_area() {
        let g = GridFile::new(10, 2020, vec![Cell { lat: 0.0, lon: 0.0, pop: 1000.0 }]);
        assert_eq!(g.max_density_per_km2(), 10.0);
    }
}
