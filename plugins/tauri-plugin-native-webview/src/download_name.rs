//! Turning a webview-suggested download file name into a safe, non-clobbering
//! file name inside a caller-chosen directory.
//!
//! Deliberately **tauri-free**: the suggested name is attacker-controlled (it
//! comes from a `Content-Disposition` header or a `download` attribute on an
//! arbitrary third-party page), so the sanitising and collision logic is the
//! part that most needs unit tests — and the rest of the crate links tauri,
//! whose desktop build needs GTK/WebKit system libs that a plain
//! `cargo test` host may not have. Keeping this module free of tauri imports
//! keeps [`unique_name`] testable wherever the crate compiles at all.

use std::path::Path;

/// Name used when the suggested one sanitises away to nothing (e.g. `"../"`,
/// `"..."`, or a name made entirely of non-allowlisted characters).
const FALLBACK_NAME: &str = "download";

/// Byte cap on the sanitised name before any `-N` de-duplication suffix. Well
/// under the 255-byte per-component limit every filesystem the desktop backend
/// runs on enforces, leaving room for the suffix (at most 5 more bytes, see
/// [`MAX_DEDUPE_SUFFIX`]) without a second truncation pass.
const MAX_NAME_BYTES: usize = 150;

/// Highest `-N` suffix tried before [`unique_name`] gives up. Reaching it means
/// the directory already holds 1000 downloads of the same name, which is far
/// past "the user downloaded the file twice" and into "something is looping";
/// giving up (and letting the caller block the download) is preferred over
/// overwriting a file the user already has.
const MAX_DEDUPE_SUFFIX: u32 = 1000;

/// Pick a file name for a download landing in `dir`, derived from the
/// webview-`suggested` name and guaranteed not to name an existing entry of
/// `dir`.
///
/// `dir` is the absolute directory the download will be written into; it is
/// only probed for existing entries, never created or modified here.
/// `suggested` is the name the webview proposed and is fully untrusted.
///
/// Returns the chosen file name — a single path segment, never absolute, never
/// `.`/`..`, never containing a separator — or `None` when `dir` already holds
/// the sanitised name and all [`MAX_DEDUPE_SUFFIX`] of its de-duplicated
/// variants (the caller then blocks the download rather than clobbering).
///
/// Sanitising is an **allowlist**: `A-Z`, `a-z`, `0-9`, `.`, `_` and `-`
/// survive; every other character (including every non-ASCII one, and both
/// path separators) becomes `_`. Leading dots are then stripped, so the result
/// can be neither a dotfile nor a `.`/`..` traversal, and a name that empties
/// out becomes [`FALLBACK_NAME`]. The output is therefore always a single
/// segment, which is what makes `dir.join(name)` unable to escape `dir`.
///
/// De-duplication appends `-1`, `-2`, … **before** the extension (the last
/// `.`), so `report.pdf` becomes `report-1.pdf` rather than `report.pdf-1`.
/// The check is a `Path::exists` probe per candidate and so is inherently
/// racy against a concurrent writer; the desktop backend is the only writer
/// into its own per-instance download directory, so the race is not worth a
/// create-exclusive dance here.
pub(crate) fn unique_name(dir: &Path, suggested: &str) -> Option<String> {
    let base = sanitize_segment(suggested);
    if !dir.join(&base).exists() {
        return Some(base);
    }
    let (stem, extension) = split_extension(&base);
    (1..=MAX_DEDUPE_SUFFIX).find_map(|counter| {
        let candidate = format!("{stem}-{counter}{extension}");
        (!dir.join(&candidate).exists()).then_some(candidate)
    })
}

/// Reduce an untrusted suggested name to one safe path segment — see
/// [`unique_name`]'s remarks for the allowlist, the leading-dot strip, the
/// [`MAX_NAME_BYTES`] cap and the [`FALLBACK_NAME`].
fn sanitize_segment(suggested: &str) -> String {
    let mapped: String = suggested
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    // Every surviving character is ASCII, so a byte truncation can never split
    // a character and the byte cap is also a character cap.
    let trimmed = mapped.trim_start_matches('.');
    let capped = &trimmed[..trimmed.len().min(MAX_NAME_BYTES)];
    if capped.is_empty() {
        FALLBACK_NAME.to_owned()
    } else {
        capped.to_owned()
    }
}

/// Split a sanitised name into `(stem, extension)` at its **last** `.`, with
/// the extension carrying the dot (`("report", ".pdf")`) or empty when there
/// is none. A name whose only dot is leading cannot occur — [`sanitize_segment`]
/// strips those — so the stem is never empty.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) => name.split_at(index),
        None => (name, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// A plain name in an empty directory is returned unchanged — the common
    /// case must not mangle what the server suggested.
    #[test]
    fn plain_name_in_empty_dir_is_returned_unchanged() {
        let dir = tempdir().expect("tempdir");
        assert_eq!(
            unique_name(dir.path(), "report.pdf").as_deref(),
            Some("report.pdf")
        );
    }

    /// Path separators and traversal segments are neutralised into `_`, so the
    /// result names a file *inside* `dir` — this is the guard that keeps a
    /// hostile `Content-Disposition` from writing outside the download
    /// directory. Asserted on the joined path, not just the name, so the test
    /// fails if `unique_name` ever returned something `join` treats as
    /// absolute or parent-relative.
    #[test]
    fn traversal_and_separators_cannot_escape_the_directory() {
        let dir = tempdir().expect("tempdir");
        for suggested in [
            "../../etc/passwd",
            "..\\..\\windows\\system32\\evil.dll",
            "/etc/passwd",
            "sub/dir/file.txt",
        ] {
            let name = unique_name(dir.path(), suggested).expect("a name");
            assert!(
                !name.contains('/') && !name.contains('\\'),
                "`{suggested}` kept a separator: `{name}`"
            );
            let joined = dir.path().join(&name);
            assert_eq!(
                joined.parent(),
                Some(dir.path()),
                "`{suggested}` escaped the download dir as `{}`",
                joined.display()
            );
        }
    }

    /// A name that is empty or nothing but dots (`..`, `...`) sanitises away
    /// entirely and falls back to `download` — never to an empty name, which
    /// `join` would resolve back to the directory itself. (A name of rejected
    /// characters does *not* empty out: each becomes `_`, e.g. `"   "` →
    /// `"___"`.)
    #[test]
    fn fully_stripped_names_fall_back_to_download() {
        let dir = tempdir().expect("tempdir");
        for suggested in ["", ".", "..", "..."] {
            assert_eq!(
                unique_name(dir.path(), suggested).as_deref(),
                Some(FALLBACK_NAME),
                "`{suggested}` should fall back"
            );
        }
    }

    /// Leading dots are stripped so a download can never land as a dotfile
    /// (invisible to the user in Finder/Explorer) — while interior dots, which
    /// carry the extension, survive.
    #[test]
    fn leading_dots_are_stripped_but_interior_dots_survive() {
        let dir = tempdir().expect("tempdir");
        assert_eq!(
            unique_name(dir.path(), ".bashrc").as_deref(),
            Some("bashrc")
        );
        assert_eq!(
            unique_name(dir.path(), "my.archive.tar.gz").as_deref(),
            Some("my.archive.tar.gz")
        );
    }

    /// Non-ASCII and shell/quoting characters map to `_`, keeping the name
    /// within the allowlist the doc promises.
    #[test]
    fn out_of_allowlist_characters_become_underscores() {
        let dir = tempdir().expect("tempdir");
        assert_eq!(
            unique_name(dir.path(), "ré port;rm -rf.pdf").as_deref(),
            Some("r__port_rm_-rf.pdf")
        );
    }

    /// An over-long suggestion is capped, and the cap leaves headroom for the
    /// de-duplication suffix so no filesystem's 255-byte component limit is
    /// approached.
    #[test]
    fn over_long_names_are_capped() {
        let dir = tempdir().expect("tempdir");
        let name = unique_name(dir.path(), &"a".repeat(5_000)).expect("a name");
        assert_eq!(name.len(), MAX_NAME_BYTES);
    }

    /// An existing file makes the next download land beside it as `-1`, with
    /// the suffix **before** the extension so the file stays openable by type.
    /// Repeated collisions keep counting up rather than reusing `-1`.
    #[test]
    fn collisions_append_an_incrementing_suffix_before_the_extension() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join("report.pdf"), b"x").expect("write");
        assert_eq!(
            unique_name(dir.path(), "report.pdf").as_deref(),
            Some("report-1.pdf")
        );
        fs::write(dir.path().join("report-1.pdf"), b"x").expect("write");
        assert_eq!(
            unique_name(dir.path(), "report.pdf").as_deref(),
            Some("report-2.pdf")
        );
    }

    /// An extension-less name still de-duplicates, appending the suffix at the
    /// end.
    #[test]
    fn collisions_on_an_extension_less_name_append_at_the_end() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join("archive"), b"x").expect("write");
        assert_eq!(
            unique_name(dir.path(), "archive").as_deref(),
            Some("archive-1")
        );
    }

    /// A directory entry collides just like a file does — the download must
    /// not be pointed at a path that already names a directory.
    #[test]
    fn an_existing_directory_also_counts_as_a_collision() {
        let dir = tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("report.pdf")).expect("mkdir");
        assert_eq!(
            unique_name(dir.path(), "report.pdf").as_deref(),
            Some("report-1.pdf")
        );
    }

    /// Exhausting every de-duplication suffix yields `None` rather than a name
    /// that would overwrite one of the existing files. The caller blocks the
    /// download on `None`.
    #[test]
    fn exhausting_every_suffix_yields_none() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join("f.bin"), b"x").expect("write");
        for counter in 1..=MAX_DEDUPE_SUFFIX {
            fs::write(dir.path().join(format!("f-{counter}.bin")), b"x").expect("write");
        }
        assert_eq!(unique_name(dir.path(), "f.bin"), None);
    }

    /// The sanitised name is deterministic: two calls for the same suggestion
    /// against the same (unchanged) directory agree. Guards against any future
    /// entropy (timestamps, randomness) creeping into the name.
    #[test]
    fn naming_is_deterministic_for_an_unchanged_directory() {
        let dir = tempdir().expect("tempdir");
        assert_eq!(
            unique_name(dir.path(), "a b.txt"),
            unique_name(dir.path(), "a b.txt")
        );
    }
}
