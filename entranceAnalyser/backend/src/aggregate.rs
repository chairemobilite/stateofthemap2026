//! Aggregate GHS-POP native pixels into `factor × factor` super-cells.
//!
//! GHS-POP is published on a Mollweide grid where every pixel already covers
//! a 1 km × 1 km equal-area patch (population = number of people in the
//! patch). To produce an `N` km grid we just sum every `factor = N` native
//! pixels within an `N × N` super-cell. No interpolation, no projection
//! distortion.
//!
//! This module is deliberately decoupled from the on-disk TIFF: it operates
//! on a row-major slice of `f32` pixels keyed by `(x_origin, y_origin,
//! width, height)`. The `build-grid` binary calls [`Aggregator::ingest`]
//! once per TIFF strip/tile, then calls [`Aggregator::finish`] to get the
//! aggregated grid.

/// In-progress aggregation of native pixels into super-cells.
///
/// Non-finite pixels (including the `NaN`s that `geotiff_pop`'s
/// [`decoding_to_f32`] emits for integer-typed nodata sentinels like
/// GHS-BUILT-V's `0xFFFFFFFF`) and non-positive pixels (GHS-POP's
/// `-200` ocean mask, legitimate zeros) are skipped. Anything above
/// zero is added to the super-cell's running sum.
pub struct Aggregator {
    /// Width of the super-cell grid in cells.
    pub out_width: usize,
    /// Height of the super-cell grid in cells.
    pub out_height: usize,
    /// Aggregation factor: how many native pixels per super-cell side.
    pub factor: usize,
    /// `out_width * out_height` running sums.
    sums: Vec<f32>,
}

impl Aggregator {
    /// Create an aggregator for a `native_width × native_height` source
    /// raster grouped `factor × factor` pixels per super-cell.
    ///
    /// Edge super-cells that fall partly off the right/bottom of the source
    /// raster are kept (population there is just summed over the available
    /// pixels — there is no source data outside).
    pub fn new(native_width: usize, native_height: usize, factor: usize) -> Self {
        assert!(factor >= 1, "aggregation factor must be ≥ 1");
        let out_width = native_width.div_ceil(factor);
        let out_height = native_height.div_ceil(factor);
        Self {
            out_width,
            out_height,
            factor,
            sums: vec![0.0; out_width * out_height],
        }
    }

    /// Add the population in a contiguous block of native pixels
    /// (`x_origin..x_origin+width`, `y_origin..y_origin+height`,
    /// row-major) to the aggregator.
    pub fn ingest(
        &mut self,
        x_origin: usize,
        y_origin: usize,
        width: usize,
        height: usize,
        pixels: &[f32],
    ) {
        debug_assert_eq!(pixels.len(), width * height);
        for j in 0..height {
            let row = &pixels[j * width..(j + 1) * width];
            let oy = (y_origin + j) / self.factor;
            for (i, &v) in row.iter().enumerate() {
                if !v.is_finite() || v <= 0.0 {
                    continue;
                }
                let ox = (x_origin + i) / self.factor;
                self.sums[oy * self.out_width + ox] += v;
            }
        }
    }

    /// Consume the aggregator and yield only the populated super-cells.
    ///
    /// Each yielded item is `(out_x, out_y, population)`.
    pub fn finish(self, min_population: f32) -> impl Iterator<Item = (usize, usize, f32)> {
        let Self { out_width, sums, .. } = self;
        sums.into_iter().enumerate().filter_map(move |(idx, pop)| {
            if pop >= min_population {
                Some((idx % out_width, idx / out_width, pop))
            } else {
                None
            }
        })
    }

    /// Consume the aggregator and return the dense row-major sums array.
    ///
    /// Exposed so `build-grid` can merge two aggregations (one per raster)
    /// index-by-index when the operator provides a built-volume companion.
    pub fn into_dense(self) -> Vec<f32> {
        self.sums
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case(1, 4)]   // 4×4 cells of 1 native pixel each
    #[case(2, 2)]   // 2×2 cells of 2×2 native pixels
    #[case(4, 1)]   // 1×1 cell of 4×4 native pixels (= total)
    fn aggregates_uniform_input(#[case] factor: usize, #[case] expected_side: usize) {
        let mut a = Aggregator::new(4, 4, factor);
        let pixels: Vec<f32> = (0..16).map(|_| 1.0).collect();
        a.ingest(0, 0, 4, 4, &pixels);
        let cells: Vec<_> = a.finish(0.0).collect();
        let area = factor * factor;
        assert_eq!(cells.len(), expected_side * expected_side);
        for (_, _, pop) in &cells {
            assert!((pop - area as f32).abs() < 1e-5);
        }
    }

    #[test]
    fn negatives_and_nans_are_dropped() {
        let mut a = Aggregator::new(2, 2, 1);
        let pixels: Vec<f32> = vec![10.0, -200.0, f32::NAN, 5.0];
        a.ingest(0, 0, 2, 2, &pixels);
        let cells: Vec<_> = a.finish(0.5).collect();
        assert_eq!(cells.len(), 2, "negative + NaN cells should not survive");
        let mut pops: Vec<_> = cells.iter().map(|(_, _, p)| *p).collect();
        pops.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(pops, vec![5.0, 10.0]);
    }

    #[test]
    fn min_population_filters() {
        let mut a = Aggregator::new(2, 2, 1);
        a.ingest(0, 0, 2, 2, &[100.0, 1.0, 0.0, 0.0]);
        let cells: Vec<_> = a.finish(50.0).collect();
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].2, 100.0);
    }

    #[test]
    fn ingests_multiple_strips() {
        // 4 × 4 native, factor 2 → 2 × 2 super-cells.
        let mut a = Aggregator::new(4, 4, 2);
        // Two horizontal strips of 4 × 2 pixels each.
        a.ingest(0, 0, 4, 2, &[1.0; 8]);
        a.ingest(0, 2, 4, 2, &[2.0; 8]);
        let mut cells: Vec<_> = a.finish(0.0).collect();
        cells.sort_by_key(|&(x, y, _)| (y, x));
        assert_eq!(
            cells,
            vec![
                (0, 0, 4.0), (1, 0, 4.0),  // top row: 4 pixels × 1.0
                (0, 1, 8.0), (1, 1, 8.0),  // bottom row: 4 pixels × 2.0
            ],
        );
    }

    #[test]
    fn edge_super_cells_keep_partial_data() {
        // 5 × 5 native, factor 2 → 3 × 3 super-cells; bottom row + right
        // column are 1-pixel-wide partial cells.
        let mut a = Aggregator::new(5, 5, 2);
        a.ingest(0, 0, 5, 5, &[1.0; 25]);
        let cells: Vec<_> = a.finish(0.0).collect();
        assert_eq!(cells.len(), 9);
        let total: f32 = cells.iter().map(|(_, _, p)| p).sum();
        assert_eq!(total, 25.0);
    }
}
