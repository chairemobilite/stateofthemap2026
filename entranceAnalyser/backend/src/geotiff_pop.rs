//! Streaming reader for the GHS-POP Mollweide GeoTIFF.
//!
//! The 1 km global file is ~5 GB raw / ~322 MB on disk; we never load it
//! whole. [`PopReader::for_each_pixel`] walks the TIFF chunk-by-chunk
//! (strip or tile) and calls a closure with the chunk's origin + an
//! `f32` view of its pixels.
//!
//! The reader also exposes [`PopReader::geotransform`] so callers can map
//! pixel coordinates to Mollweide metres, and [`PopReader::native_pixel_km`]
//! so the build-grid binary can verify the source resolution matches the
//! `--cell-size-km` it was asked to aggregate to.

use std::fs::File;
use std::io::{BufReader, Seek};
use std::path::Path;

use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

/// Affine geotransform from pixel coordinates `(i, j)` to Mollweide metres
/// `(x, y)`.
///
/// `x = upper_left_x + (i + 0.5) · pixel_size_x`
/// `y = upper_left_y - (j + 0.5) · pixel_size_y`
#[derive(Debug, Clone, Copy)]
pub struct GeoTransform {
    pub upper_left_x: f64,
    pub upper_left_y: f64,
    pub pixel_size_x: f64,
    pub pixel_size_y: f64,
}

impl GeoTransform {
    /// Mollweide metres at the centre of pixel `(i, j)`.
    pub fn pixel_center(&self, i: f64, j: f64) -> (f64, f64) {
        (
            self.upper_left_x + (i + 0.5) * self.pixel_size_x,
            self.upper_left_y - (j + 0.5) * self.pixel_size_y,
        )
    }
}

pub struct PopReader<R: std::io::Read + Seek> {
    decoder: Decoder<R>,
    pub width: u32,
    pub height: u32,
    pub geotransform: GeoTransform,
}

impl PopReader<BufReader<File>> {
    /// Open a GHS-POP GeoTIFF from disk.
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let file = BufReader::new(File::open(path)?);
        Self::from_reader(file)
    }
}

impl<R: std::io::Read + Seek> PopReader<R> {
    /// Build a reader from an arbitrary seekable byte source. Tests use
    /// this with an in-memory `Cursor`.
    pub fn from_reader(reader: R) -> Result<Self, Box<dyn std::error::Error>> {
        let mut decoder = Decoder::new(reader)?;
        let width: u32 = decoder.get_tag_unsigned(Tag::ImageWidth)?;
        let height: u32 = decoder.get_tag_unsigned(Tag::ImageLength)?;

        let scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag)?;
        let tiepoint = decoder.get_tag_f64_vec(Tag::ModelTiepointTag)?;
        if scale.len() < 2 || tiepoint.len() < 6 {
            return Err("missing ModelPixelScale / ModelTiepoint tags".into());
        }
        let geotransform = GeoTransform {
            upper_left_x: tiepoint[3] - tiepoint[0] * scale[0],
            upper_left_y: tiepoint[4] + tiepoint[1] * scale[1],
            pixel_size_x: scale[0],
            pixel_size_y: scale[1],
        };

        Ok(Self { decoder, width, height, geotransform })
    }

    /// Native pixel size in kilometres (assumes square pixels in metres).
    pub fn native_pixel_km(&self) -> f64 {
        self.geotransform.pixel_size_x / 1000.0
    }

    /// Walk every chunk (strip or tile) in raster order and call `on_chunk`
    /// with the chunk's pixel-space origin, dimensions and pixel data
    /// converted to `f32`.
    ///
    /// Strips are laid out left-to-right top-to-bottom in the TIFF; tiles
    /// likewise (chunk index = `tile_y * tiles_x + tile_x`).
    pub fn for_each_pixel<F>(
        &mut self,
        mut on_chunk: F,
    ) -> Result<(), Box<dyn std::error::Error>>
    where
        F: FnMut(usize, usize, usize, usize, &[f32]),
    {
        let chunk_kind = self.decoder.get_chunk_type();
        let n_chunks = match chunk_kind {
            tiff::decoder::ChunkType::Strip => self.decoder.strip_count()?,
            tiff::decoder::ChunkType::Tile => self.decoder.tile_count()?,
        };
        let (default_w, default_h) = self.decoder.chunk_dimensions();
        let chunks_per_row = self.width.div_ceil(default_w);

        let mut buf_f32: Vec<f32> = Vec::new();

        for idx in 0..n_chunks {
            let (w, h) = self.decoder.chunk_data_dimensions(idx);
            let (origin_x, origin_y) = match chunk_kind {
                tiff::decoder::ChunkType::Strip => (0_u32, idx * default_h),
                tiff::decoder::ChunkType::Tile => {
                    ((idx % chunks_per_row) * default_w, (idx / chunks_per_row) * default_h)
                }
            };

            let chunk = self.decoder.read_chunk(idx)?;
            let n_pixels = (w as usize) * (h as usize);
            buf_f32.clear();
            buf_f32.reserve(n_pixels);
            decoding_to_f32(&chunk, n_pixels, &mut buf_f32)?;

            on_chunk(origin_x as usize, origin_y as usize, w as usize, h as usize, &buf_f32);
        }
        Ok(())
    }
}

/// Convert the first `n` pixels of `chunk` into `f32` and append them to
/// `out`. Errors out on multi-sample / non-numeric chunk types — GHS-POP is
/// always single-sample numeric.
fn decoding_to_f32(
    chunk: &DecodingResult,
    n: usize,
    out: &mut Vec<f32>,
) -> Result<(), Box<dyn std::error::Error>> {
    match chunk {
        DecodingResult::F32(v) => out.extend(v.iter().take(n).copied()),
        DecodingResult::F64(v) => out.extend(v.iter().take(n).map(|x| *x as f32)),
        DecodingResult::U16(v) => out.extend(v.iter().take(n).map(|x| *x as f32)),
        DecodingResult::U32(v) => out.extend(v.iter().take(n).map(|x| *x as f32)),
        DecodingResult::I16(v) => out.extend(v.iter().take(n).map(|x| *x as f32)),
        DecodingResult::I32(v) => out.extend(v.iter().take(n).map(|x| *x as f32)),
        other => return Err(format!("unsupported pixel type: {other:?}").into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
    use tiff::tags::Tag;

    #[test]
    fn pixel_center_uses_top_left_corner_convention() {
        let gt = GeoTransform {
            upper_left_x: -18_041_000.0,
            upper_left_y: 9_020_500.0,
            pixel_size_x: 1000.0,
            pixel_size_y: 1000.0,
        };
        let (x, y) = gt.pixel_center(0.0, 0.0);
        assert_eq!(x, -18_040_500.0);
        assert_eq!(y, 9_020_000.0);
        let (x2, y2) = gt.pixel_center(1.0, 1.0);
        assert_eq!(x2 - x, 1000.0);
        assert_eq!(y - y2, 1000.0);
    }

    /// Round-trip a tiny synthetic Float32 GeoTIFF through the encoder and
    /// back through `PopReader` to verify the geotransform is recovered
    /// and the pixels stream out in raster order.
    #[test]
    fn reads_synthetic_geotiff() {
        let pixels: Vec<f32> = (0..16).map(|i| i as f32).collect();
        let mut buf = Cursor::new(Vec::<u8>::new());
        {
            let mut enc = TiffEncoder::new(&mut buf).unwrap();
            let mut img = enc.new_image::<Gray32Float>(4, 4).unwrap();
            // 1 km square pixels, top-left at (-2 km, +2 km) in some
            // arbitrary metric CRS.
            img.encoder()
                .write_tag(Tag::ModelPixelScaleTag, &[1000.0_f64, 1000.0, 0.0][..])
                .unwrap();
            img.encoder()
                .write_tag(
                    Tag::ModelTiepointTag,
                    &[0.0_f64, 0.0, 0.0, -2000.0, 2000.0, 0.0][..],
                )
                .unwrap();
            img.write_data(&pixels).unwrap();
        }
        buf.set_position(0);

        let mut reader = PopReader::from_reader(buf).unwrap();
        assert_eq!(reader.width, 4);
        assert_eq!(reader.height, 4);
        assert!((reader.native_pixel_km() - 1.0).abs() < 1e-9);
        assert_eq!(reader.geotransform.upper_left_x, -2000.0);
        assert_eq!(reader.geotransform.upper_left_y, 2000.0);

        let mut seen = Vec::<(usize, usize, f32)>::new();
        reader
            .for_each_pixel(|ox, oy, w, h, px| {
                for j in 0..h {
                    for i in 0..w {
                        seen.push((ox + i, oy + j, px[j * w + i]));
                    }
                }
            })
            .unwrap();
        assert_eq!(seen.len(), 16);
        // Pixel (i, j) should equal index j*4 + i in our generator.
        for (i, j, v) in &seen {
            assert_eq!(*v, (j * 4 + i) as f32, "({i},{j}) = {v}");
        }
    }
}
