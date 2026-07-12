/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

//! Auto-transcode LZW-compressed TIFFs to uncompressed so the
//! `tiff = 0.11` crate can read them.
//!
//! Background: the `tiff` crate's LZW decoder panics mid-raster with
//! `IoError(UnexpectedEof, "no lzw end code found")` on strips that
//! omit the explicit end-of-information code. GHS-BUILT-V ships
//! exactly such strips, so `build-grid` can't ingest it directly. A
//! crate-level fix requires patching upstream `weezl` + `tiff`, which
//! means maintaining a fork. Rather than pay that bill, we sidestep
//! the issue at the CLI boundary: if the input is LZW-compressed, we
//! ask `gdal_translate` to re-encode it to an uncompressed sibling
//! first, then read the sibling.
//!
//! The sibling is cached next to the original as
//! `<basename>.uncompressed.tif` and reused when its mtime is newer
//! than the original — so running `build-grid` three times in a row
//! pays the ~30 s re-encode cost only once.
//!
//! Requires `gdal_translate` on `$PATH`. Everyone running `build-grid`
//! already has GDAL installed (they used `gdalinfo` to validate their
//! download), and the README's Troubleshooting section documents this
//! dependency.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tiff::decoder::Decoder;
use tiff::tags::Tag;

/// TIFF compression tag value for LZW (TIFF 6.0 spec §13).
const TIFF_COMPRESSION_LZW: u32 = 5;

/// Every failure mode `ensure_tiff_crate_readable` can hit, with enough
/// context that the caller can print an actionable message.
#[derive(Debug)]
pub enum TranscodeError {
    Io(std::io::Error),
    Tiff(tiff::TiffError),
    /// `gdal_translate` is not on `$PATH`. Recover by installing GDAL
    /// (e.g. `brew install gdal` / `apt-get install gdal-bin`) or by
    /// re-encoding the raster manually as documented in the README.
    GdalMissing,
    /// `gdal_translate` ran but exited non-zero. The stderr is
    /// inherited from the child so the operator already saw the
    /// underlying complaint; we just surface the exit code.
    GdalFailed {
        status: Option<i32>,
    },
}

impl std::fmt::Display for TranscodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::Tiff(e) => write!(f, "TIFF header error: {e}"),
            Self::GdalMissing => write!(
                f,
                "`gdal_translate` not found on $PATH; install GDAL (e.g. \
                 `brew install gdal` / `apt-get install gdal-bin`) or \
                 pre-transcode the raster to uncompressed TIFF manually \
                 (see entranceAnalyser/README.md → Troubleshooting)",
            ),
            Self::GdalFailed { status } => match status {
                Some(c) => write!(f, "gdal_translate exited with status {c}"),
                None => write!(f, "gdal_translate terminated by signal"),
            },
        }
    }
}

impl std::error::Error for TranscodeError {}

impl From<std::io::Error> for TranscodeError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<tiff::TiffError> for TranscodeError {
    fn from(e: tiff::TiffError) -> Self {
        Self::Tiff(e)
    }
}

/// Return a path that the `tiff` crate can read reliably.
///
/// - If `path` isn't LZW-compressed, the original path is returned
///   untouched (the crate already handles it).
/// - If it is LZW, a sibling `<stem>.uncompressed.tif` is produced by
///   `gdal_translate -co COMPRESS=NONE` and returned. The sibling is
///   cached across runs; it's regenerated only when the original is
///   newer (or the sibling is missing).
///
/// The `[lzw] ...` progress lines go to stderr so they don't
/// interleave with `build-grid`'s structured stdout summary.
pub fn ensure_tiff_crate_readable(path: &Path) -> Result<PathBuf, TranscodeError> {
    if !is_lzw(path)? {
        return Ok(path.to_path_buf());
    }
    let cached = uncompressed_sibling(path);
    if cache_is_fresh(path, &cached)? {
        eprintln!(
            "[lzw] reusing cached uncompressed TIFF: {}",
            cached.display(),
        );
        return Ok(cached);
    }
    transcode_to_uncompressed(path, &cached)?;
    Ok(cached)
}

/// Read only the TIFF header and return whether the raster uses LZW
/// compression. Cheap: touches just the first page's tags.
fn is_lzw(path: &Path) -> Result<bool, TranscodeError> {
    let file = fs::File::open(path)?;
    let mut decoder = Decoder::new(std::io::BufReader::new(file))?;
    let compression: u32 = decoder.get_tag_unsigned(Tag::Compression)?;
    Ok(compression == TIFF_COMPRESSION_LZW)
}

/// Convention for the cached uncompressed sibling: same directory,
/// same stem, `.uncompressed.tif` extension. Keeping it next to the
/// source makes provenance obvious and lets the operator delete it
/// with a plain `rm` when they no longer need it.
fn uncompressed_sibling(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "input".to_string());
    path.with_file_name(format!("{stem}.uncompressed.tif"))
}

/// A cached sibling is fresh when it exists and its mtime is at least
/// as recent as the original. If we can't compare mtimes (e.g. a
/// filesystem without timestamp support), play safe and regenerate.
fn cache_is_fresh(original: &Path, cached: &Path) -> Result<bool, TranscodeError> {
    if !cached.exists() {
        return Ok(false);
    }
    let orig_mtime = fs::metadata(original)?.modified()?;
    let cached_mtime = fs::metadata(cached)?.modified()?;
    Ok(cached_mtime >= orig_mtime)
}

fn transcode_to_uncompressed(src: &Path, dst: &Path) -> Result<(), TranscodeError> {
    eprintln!(
        "[lzw] re-encoding {} → {} (one-off, ~30 s; see lzw_transcode.rs for why)",
        src.display(),
        dst.display(),
    );
    let status = Command::new("gdal_translate")
        .arg("-co")
        .arg("COMPRESS=NONE")
        .arg("-co")
        .arg("TILED=YES")
        .arg("-co")
        .arg("BIGTIFF=YES")
        .arg(src)
        .arg(dst)
        .status()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => TranscodeError::GdalMissing,
            _ => TranscodeError::Io(e),
        })?;
    if !status.success() {
        // If the transcode failed partway, remove the half-written
        // sibling so the next run retries from scratch instead of
        // hitting our mtime cache with a corrupt file.
        let _ = fs::remove_file(dst);
        return Err(TranscodeError::GdalFailed {
            status: status.code(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;
    use std::io::Cursor;
    use tempfile::TempDir;
    use tiff::encoder::{colortype::Gray32Float, Compression, TiffEncoder};

    /// Write a tiny (2×2) TIFF to disk with the requested compression.
    /// Returns the file path inside `dir`; the caller owns cleanup via
    /// `dir` going out of scope.
    fn write_tiff(dir: &Path, name: &str, compression: Compression) -> PathBuf {
        let path = dir.join(name);
        let mut buf = Cursor::new(Vec::<u8>::new());
        {
            let mut enc = TiffEncoder::new(&mut buf)
                .unwrap()
                .with_compression(compression);
            let pixels: [f32; 4] = [1.0, 2.0, 3.0, 4.0];
            enc.write_image::<Gray32Float>(2, 2, &pixels).unwrap();
        }
        std::fs::write(&path, buf.into_inner()).unwrap();
        path
    }

    #[rstest]
    #[case::uncompressed(Compression::Uncompressed, false)]
    #[case::lzw(Compression::Lzw, true)]
    #[case::packbits(Compression::Packbits, false)]
    fn is_lzw_detects_compression(#[case] compression: Compression, #[case] expected: bool) {
        let dir = TempDir::new().unwrap();
        let p = write_tiff(dir.path(), "sample.tif", compression);
        assert_eq!(is_lzw(&p).unwrap(), expected);
    }

    #[test]
    fn uncompressed_sibling_adds_marker_suffix() {
        let p = Path::new("/tmp/data/GHS_BUILT_V.tif");
        assert_eq!(
            uncompressed_sibling(p),
            Path::new("/tmp/data/GHS_BUILT_V.uncompressed.tif"),
        );
    }

    #[test]
    fn ensure_tiff_crate_readable_is_noop_for_uncompressed() {
        let dir = TempDir::new().unwrap();
        let p = write_tiff(dir.path(), "plain.tif", Compression::Uncompressed);
        let out = ensure_tiff_crate_readable(&p).unwrap();
        assert_eq!(out, p);
    }

    /// When the cached sibling doesn't exist, we always need to
    /// regenerate. When it does exist and is newer than or equal to
    /// the source, we reuse. Filesystem mtime resolution is second-
    /// granular on some systems, hence the `>=` rather than `>` in
    /// `cache_is_fresh`.
    #[test]
    fn cache_is_fresh_tracks_presence_and_mtime_ordering() {
        let dir = TempDir::new().unwrap();
        let orig = write_tiff(dir.path(), "src.tif", Compression::Uncompressed);
        let cached = dir.path().join("src.uncompressed.tif");
        assert!(!cache_is_fresh(&orig, &cached).unwrap());
        // Copy orig → cached. On modern filesystems the copy has a
        // strictly later mtime; on CI runners with 1-second resolution
        // the mtimes may match, which still satisfies our `>=` rule.
        std::fs::copy(&orig, &cached).unwrap();
        assert!(cache_is_fresh(&orig, &cached).unwrap());
    }
}
