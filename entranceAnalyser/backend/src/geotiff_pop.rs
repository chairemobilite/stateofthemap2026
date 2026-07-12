/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

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
    /// Value published by the raster as its "no data" sentinel
    /// (TIFF tag 42113 / `GDAL_NODATA`). `None` when the tag is absent.
    ///
    /// Kept as `f64` because GHS rasters ship with values like `-200`
    /// (GHS-POP, Float64) and `4294967295` (GHS-BUILT-V, UInt32) — both
    /// fit exactly in f64 but the UInt32 one rounds to `2^32` if cast
    /// straight to f32, which is why per-type integer comparison in
    /// [`decoding_to_f32`] happens *before* the cast.
    pub nodata: Option<f64>,
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

        // GDAL writes the nodata sentinel as an ASCII TIFF tag (42113).
        // Both GHS rasters set it (`-200` for POP, `4294967295` for
        // BUILT-V); missing tag is rare but benign — we just lose the
        // filter.
        let nodata = decoder
            .get_tag_ascii_string(Tag::Unknown(42113))
            .ok()
            .and_then(|s| s.trim().parse::<f64>().ok());

        Ok(Self {
            decoder,
            width,
            height,
            geotransform,
            nodata,
        })
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
    pub fn for_each_pixel<F>(&mut self, mut on_chunk: F) -> Result<(), Box<dyn std::error::Error>>
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
                tiff::decoder::ChunkType::Tile => (
                    (idx % chunks_per_row) * default_w,
                    (idx / chunks_per_row) * default_h,
                ),
            };

            let chunk = self.decoder.read_chunk(idx)?;
            let n_pixels = (w as usize) * (h as usize);
            buf_f32.clear();
            buf_f32.reserve(n_pixels);
            decoding_to_f32(&chunk, n_pixels, self.nodata, &mut buf_f32)?;

            on_chunk(
                origin_x as usize,
                origin_y as usize,
                w as usize,
                h as usize,
                &buf_f32,
            );
        }
        Ok(())
    }
}

/// Convert the first `n` pixels of `chunk` into `f32` and append them to
/// `out`. Errors out on multi-sample / non-numeric chunk types — GHS-POP is
/// always single-sample numeric.
///
/// Pixels that match the per-raster `nodata` sentinel are emitted as
/// `f32::NAN` so downstream aggregators filter them out via
/// `is_finite()`. The comparison is done in the native integer type
/// *before* the `as f32` cast, because e.g. `0xFFFFFFFF as f32` rounds
/// up to `2^32` — far from zero, so without this pre-cast check the
/// aggregator would happily sum ocean tiles as ~`4.3e11 m³` of built
/// volume. Ask us how we know.
fn decoding_to_f32(
    chunk: &DecodingResult,
    n: usize,
    nodata: Option<f64>,
    out: &mut Vec<f32>,
) -> Result<(), Box<dyn std::error::Error>> {
    /// Narrow `nodata` to the exact integer in `T::MIN..=T::MAX` it
    /// represents, or `None` if the sentinel can't be expressed in
    /// that integer type (which means no raw pixel can match it).
    fn as_int<T>(nodata: Option<f64>, min: f64, max: f64, cast: fn(f64) -> T) -> Option<T> {
        nodata.and_then(|n| {
            if n.is_finite() && n.fract() == 0.0 && (min..=max).contains(&n) {
                Some(cast(n))
            } else {
                None
            }
        })
    }
    match chunk {
        DecodingResult::F32(v) => {
            let nd = nodata.map(|n| n as f32);
            out.extend(v.iter().take(n).map(|&x| match nd {
                Some(nd) if x == nd => f32::NAN,
                _ => x,
            }));
        }
        DecodingResult::F64(v) => {
            out.extend(v.iter().take(n).map(|&x| match nodata {
                Some(nd) if x == nd => f32::NAN,
                _ => x as f32,
            }));
        }
        DecodingResult::U16(v) => {
            let nd = as_int::<u16>(nodata, 0.0, u16::MAX as f64, |x| x as u16);
            out.extend(v.iter().take(n).map(|&x| match nd {
                Some(nd) if x == nd => f32::NAN,
                _ => x as f32,
            }));
        }
        DecodingResult::U32(v) => {
            let nd = as_int::<u32>(nodata, 0.0, u32::MAX as f64, |x| x as u32);
            out.extend(v.iter().take(n).map(|&x| match nd {
                Some(nd) if x == nd => f32::NAN,
                _ => x as f32,
            }));
        }
        DecodingResult::I16(v) => {
            let nd = as_int::<i16>(nodata, i16::MIN as f64, i16::MAX as f64, |x| x as i16);
            out.extend(v.iter().take(n).map(|&x| match nd {
                Some(nd) if x == nd => f32::NAN,
                _ => x as f32,
            }));
        }
        DecodingResult::I32(v) => {
            let nd = as_int::<i32>(nodata, i32::MIN as f64, i32::MAX as f64, |x| x as i32);
            out.extend(v.iter().take(n).map(|&x| match nd {
                Some(nd) if x == nd => f32::NAN,
                _ => x as f32,
            }));
        }
        other => return Err(format!("unsupported pixel type: {other:?}").into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;
    use std::io::Cursor;
    use tiff::encoder::{
        colortype::{Gray32, Gray32Float},
        TiffEncoder,
    };
    use tiff::tags::Tag;

    /// Build a tiny one-strip TIFF and feed it back through [`PopReader`],
    /// returning the flattened pixel stream. Writes the given
    /// `GDAL_NODATA` string when `nodata` is `Some` so tests can cover
    /// the "with sentinel" and "without sentinel" branches uniformly.
    fn roundtrip_u32(pixels: &[u32], nodata: Option<&str>) -> Vec<f32> {
        assert_eq!(pixels.len(), 4);
        let mut buf = Cursor::new(Vec::<u8>::new());
        {
            let mut enc = TiffEncoder::new(&mut buf).unwrap();
            let mut img = enc.new_image::<Gray32>(2, 2).unwrap();
            img.encoder()
                .write_tag(Tag::ModelPixelScaleTag, &[1000.0_f64, 1000.0, 0.0][..])
                .unwrap();
            img.encoder()
                .write_tag(
                    Tag::ModelTiepointTag,
                    &[0.0_f64, 0.0, 0.0, 0.0, 0.0, 0.0][..],
                )
                .unwrap();
            if let Some(s) = nodata {
                img.encoder().write_tag(Tag::Unknown(42113), s).unwrap();
            }
            img.write_data(pixels).unwrap();
        }
        buf.set_position(0);
        let mut reader = PopReader::from_reader(buf).unwrap();
        let mut seen = Vec::<f32>::new();
        reader
            .for_each_pixel(|_, _, w, h, px| {
                assert_eq!(px.len(), w * h);
                seen.extend_from_slice(px);
            })
            .unwrap();
        seen
    }

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

    #[rstest]
    // Ocean-like UInt32 raster where every pixel carries the GHS-BUILT-V
    // nodata sentinel `0xFFFFFFFF`. Without the nodata-aware decoder each
    // pixel would cast to `2^32` as f32 — that's the "429,496,729,600 m³
    // ocean concrete" bug this test locks down.
    #[case::all_nodata(&[u32::MAX, u32::MAX, u32::MAX, u32::MAX], "4294967295", 4)]
    // Mixed: half nodata, half real data.
    #[case::mixed(&[u32::MAX, 42, u32::MAX, 7], "4294967295", 2)]
    fn u32_pixels_matching_gdal_nodata_become_nan(
        #[case] pixels: &[u32],
        #[case] nodata_tag: &str,
        #[case] expected_nan_count: usize,
    ) {
        let out = roundtrip_u32(pixels, Some(nodata_tag));
        assert_eq!(out.len(), pixels.len());
        let nan_count = out.iter().filter(|v| v.is_nan()).count();
        assert_eq!(nan_count, expected_nan_count);
        for (raw, decoded) in pixels.iter().zip(out.iter()) {
            if *raw == u32::MAX {
                assert!(decoded.is_nan(), "nodata pixel should decode to NaN");
            } else {
                assert_eq!(*decoded, *raw as f32);
            }
        }
    }

    /// When the TIFF has no `GDAL_NODATA` tag, the reader must keep
    /// every pixel as-is (casting `u32::MAX` to `2^32` — which is the
    /// bug-compatible behaviour for rasters that legitimately use the
    /// full `u32` range, so we surface it rather than silently drop).
    #[test]
    fn u32_pixels_without_nodata_tag_pass_through() {
        let pixels = [u32::MAX, 5, 10, 15];
        let out = roundtrip_u32(&pixels, None);
        assert!(!out.iter().any(|v| v.is_nan()));
        assert_eq!(out[0], u32::MAX as f32); // = 2^32 after the cast
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
