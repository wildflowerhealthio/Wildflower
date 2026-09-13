//! Turning a webview-suggested download file name into a safe, non-clobbering
//! file name inside a caller-chosen directory — see
//! [Explanation.md](../docs/Explanation.md) § "Downloads (desktop)".
//!
//! Deliberately **tauri-free**: the suggested name is attacker-controlled, so
//! the sanitising and collision logic stays unit-testable on a host without
//! the GTK/WebKit libs the rest of the crate links.

use std::path::Path;

/// Name used when the suggested one sanitises away to nothing (e.g. `"../"`,
/// `"..."`, or a name made entirely of non-allowlisted characters).
const FALLBACK_NAME: &str = "download";

/// Byte cap on the sanitised name before any `-N` de-duplication suffix, far
/// enough under the universal 255-byte component limit that the suffix needs
/// no second truncation pass.
const MAX_NAME_BYTES: usize = 150;

/// Highest `-N` suffix tried before [`unique_name`] gives up — reaching it
/// means something is looping, and blocking the download beats overwriting a
/// file the user already has.
const MAX_DEDUPE_SUFFIX: u32 = 1000;

/// Pick a file name for a download landing in `dir`, derived from the fully
/// untrusted `suggested` name and guaranteed not to name an existing entry of
/// `dir`, which is only probed — never created or modified here.
///
/// Returns a single path segment, never absolute, never `.`/`..`, never
/// containing a separator: that is what makes `dir.join(name)` unable to
/// escape `dir`. `None` when the sanitised name and all
/// [`MAX_DEDUPE_SUFFIX`] of its `-N` variants are taken, so the caller blocks
/// the download rather than clobbering.
///
/// Sanitising is an allowlist (`A-Za-z0-9._-`, others become `_`, leading dots
/// stripped, [`FALLBACK_NAME`] when nothing survives) and `-N` is inserted
/// before the extension; see [Explanation.md](../docs/Explanation.md) §
/// "Downloads (desktop)". The per-candidate `Path::exists` probe is racy in
/// principle, but the desktop backend is the only writer into its own
/// per-instance download directory.
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
/// [`unique_name`] for the allowlist, the leading-dot strip and the cap.
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

/// Split a sanitised name into `(stem, extension)` at its **last** `.`, the
/// extension carrying the dot (`("report", ".pdf")`) or empty when there is
/// none. [`sanitize_segment`] strips leading dots, so the stem is never empty.
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

    /// The common case must not mangle what the server suggested.
    #[test]
    fn plain_name_in_empty_dir_is_returned_unchanged() {
        let dir = tempdir().expect("tempdir");
        assert_eq!(
            unique_name(dir.path(), "report.pdf").as_deref(),
            Some("report.pdf")
        );
    }

    /// The guard that keeps a hostile `Content-Disposition` from writing
    /// outside the download directory. Asserted on the joined path, not just
    /// the name, so anything `join` treats as absolute or parent-relative
    /// fails here too.
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

    /// A name that is empty or nothing but dots must fall back to `download`,
    /// never to an empty name — `join` would resolve that back to the
    /// directory itself. (Rejected characters do not empty out: `"   "` →
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

    /// A download must never land as a dotfile, invisible in Finder/Explorer —
    /// while interior dots, which carry the extension, survive.
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

    /// An over-long suggestion is capped well short of any filesystem's
    /// 255-byte component limit, leaving headroom for the `-N` suffix.
    #[test]
    fn over_long_names_are_capped() {
        let dir = tempdir().expect("tempdir");
        let name = unique_name(dir.path(), &"a".repeat(5_000)).expect("a name");
        assert_eq!(name.len(), MAX_NAME_BYTES);
    }

    /// The suffix goes **before** the extension so the file stays openable by
    /// type, and repeated collisions count up rather than reusing `-1`.
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

    /// A directory entry collides just like a file does.
    #[test]
    fn an_existing_directory_also_counts_as_a_collision() {
        let dir = tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("report.pdf")).expect("mkdir");
        assert_eq!(
            unique_name(dir.path(), "report.pdf").as_deref(),
            Some("report-1.pdf")
        );
    }

    /// Exhaustion must yield `None` — the caller blocks the download — rather
    /// than a name that would overwrite an existing file.
    #[test]
    fn exhausting_every_suffix_yields_none() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join("f.bin"), b"x").expect("write");
        for counter in 1..=MAX_DEDUPE_SUFFIX {
            fs::write(dir.path().join(format!("f-{counter}.bin")), b"x").expect("write");
        }
        assert_eq!(unique_name(dir.path(), "f.bin"), None);
    }

    /// Guards against entropy (timestamps, randomness) creeping into the name:
    /// two calls against an unchanged directory must agree.
    #[test]
    fn naming_is_deterministic_for_an_unchanged_directory() {
        let dir = tempdir().expect("tempdir");
        assert_eq!(
            unique_name(dir.path(), "a b.txt"),
            unique_name(dir.path(), "a b.txt")
        );
    }
}
