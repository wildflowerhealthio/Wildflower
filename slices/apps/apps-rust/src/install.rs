//! Zip-bundle extraction + name slugging for the self-hosted app upload surface.
//!
//! [`extract_zip_bundle`] unpacks an uploaded `.zip` into a staging directory,
//! guarding against the two classic archive hazards — path traversal ("zip
//! slip") and decompression bombs — and normalizing the common
//! "everything nested under one top folder" packaging into a flat root.
//! [`slugify`] turns a human app name into a DNS-label id/subdomain the store
//! and the reverse proxy can key on.
//!
//! Both are pure (no network, no DB); the create handler drives extraction on a
//! blocking pool and the store's uniqueness logic on the slug.

use std::fmt;
use std::fs;
use std::io::{self, Cursor};
use std::path::{Component, Path};

use zip::ZipArchive;

/// Cap on the declared uncompressed total across all entries — a decompression
/// bomb defence. The header-declared sizes are summed in a pre-pass and the
/// extraction refuses to start once they exceed this.
const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

/// Cap on the number of entries — bounds the per-entry loop work regardless of
/// declared sizes.
const MAX_ENTRIES: usize = 20_000;

/// Why an uploaded bundle couldn't be staged. Every variant except [`Self::Io`]
/// is a fault in the *submitted* archive (the create handler maps them to
/// `400 InvalidZip`); [`Self::Io`] is a disk-write failure on our side
/// (`500`).
#[derive(Debug)]
pub(crate) enum InstallError {
    /// The archive parsed but held no entries.
    EmptyArchive,
    /// More than [`MAX_ENTRIES`] entries.
    TooManyEntries { count: usize },
    /// The declared uncompressed total exceeded [`MAX_UNCOMPRESSED_BYTES`].
    TooLarge { declared: u64 },
    /// An entry's path escaped the staging root (a zip-slip attempt).
    Traversal { entry: String },
    /// The bytes weren't a well-formed zip (or an entry failed to decompress).
    Zip(zip::result::ZipError),
    /// A filesystem write into the staging directory failed — our fault, not the
    /// uploader's.
    Io(io::Error),
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InstallError::EmptyArchive => write!(f, "the archive contains no files"),
            InstallError::TooManyEntries { count } => {
                write!(f, "the archive has {count} entries (max {MAX_ENTRIES})")
            }
            InstallError::TooLarge { declared } => write!(
                f,
                "the archive declares {declared} uncompressed bytes (max {MAX_UNCOMPRESSED_BYTES})",
            ),
            InstallError::Traversal { entry } => {
                write!(f, "entry `{entry}` escapes the extraction root")
            }
            InstallError::Zip(error) => write!(f, "not a valid zip archive: {error}"),
            InstallError::Io(error) => write!(f, "failed to write extracted files: {error}"),
        }
    }
}

/// Extract `bytes` (an uploaded zip) into `staging`, which is created if absent.
///
/// Enforced invariants, in order:
///  - the archive is non-empty and within the [`MAX_ENTRIES`] /
///    [`MAX_UNCOMPRESSED_BYTES`] caps (checked before any file is written);
///  - every entry's path stays inside `staging` — `enclosed_name` returns `None`
///    for a `..`/absolute/drive-qualified path, which we reject rather than
///    sanitize (a traversal is a hostile bundle, not a fixable one);
///  - macOS Finder-zip litter (`__MACOSX/` resource forks, `.DS_Store`, and
///    AppleDouble `._*` files) is dropped rather than written — otherwise a
///    sibling `__MACOSX/` folder would masquerade as a second top-level
///    directory and defeat the hoist below;
///  - when the whole archive is nested under a single top-level directory (the
///    common `unzip my-app.zip` → `my-app/…` shape) with no top-level files,
///    that wrapper is hoisted away so the served root is the app itself.
///
/// # Errors
///
/// [`InstallError`] — a content fault (empty / caps / traversal / malformed) or
/// an [`InstallError::Io`] on a staging-directory write failure.
pub(crate) fn extract_zip_bundle(bytes: &[u8], staging: &Path) -> Result<(), InstallError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(InstallError::Zip)?;
    if archive.is_empty() {
        return Err(InstallError::EmptyArchive);
    }
    if archive.len() > MAX_ENTRIES {
        return Err(InstallError::TooManyEntries {
            count: archive.len(),
        });
    }
    // Pre-pass: sum the declared uncompressed sizes and bail before writing a
    // byte if they exceed the cap, so a bomb never lands on disk.
    let mut declared_total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(InstallError::Zip)?;
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_UNCOMPRESSED_BYTES {
            return Err(InstallError::TooLarge {
                declared: declared_total,
            });
        }
    }

    fs::create_dir_all(staging).map_err(InstallError::Io)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(InstallError::Zip)?;
        let raw_name = entry.name().to_owned();
        // `enclosed_name` yields the path only when it's safely inside the root
        // (no `..`, not absolute, no Windows drive/UNC prefix); `None` is a
        // traversal attempt. `.to_path_buf()` owns it so the later `&mut entry`
        // read isn't blocked by a borrow of `entry`.
        let Some(relative) = entry.enclosed_name().map(|name| name.to_path_buf()) else {
            return Err(InstallError::Traversal { entry: raw_name });
        };
        // Drop macOS Finder-zip litter before it lands on disk: writing the
        // `__MACOSX/` sibling would make the archive look like it had two
        // top-level directories and suppress the single-wrapper hoist below.
        if is_macos_junk(&relative) {
            continue;
        }
        let out_path = staging.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(InstallError::Io)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(InstallError::Io)?;
            }
            let mut out = fs::File::create(&out_path).map_err(InstallError::Io)?;
            io::copy(&mut entry, &mut out).map_err(InstallError::Io)?;
        }
    }

    hoist_single_top_dir(staging)
}

/// The launch path recorded for a bundle that ships a `launch.html` — a SMART
/// launcher. Carries the same `{origin}` / `{launch}` placeholders the cloud
/// templates use; [`SelfHostedApp::render_launch`](crate::domain::SelfHostedApp::render_launch)
/// substitutes them per request (`{origin}` → the served FHIR origin).
const LAUNCH_HTML_PATH: &str = "/launch.html?launch={launch}&iss={origin}/fhir-r4";

/// Infer the launch path for a freshly-extracted bundle rooted at `staging`
/// (call **after** [`extract_zip_bundle`], so the single-top-dir hoist has
/// already flattened the tree):
///
///  - a `launch.html` at the root → the SMART [`LAUNCH_HTML_PATH`], so a
///    launch routes to `/launch.html?…`;
///  - otherwise `None` — the app serves from its bare root, where ServeDir
///    resolves `/` to `index.html` (the pre-existing behavior).
///
/// The `index.html` case needs no stored path: the bare-origin launch already
/// lands there, so a present `index.html` and a bundle with neither file both
/// map to `None` (the latter simply 404s at launch, as before).
pub(crate) fn infer_launch_path(staging: &Path) -> Option<String> {
    staging
        .join("launch.html")
        .is_file()
        .then(|| LAUNCH_HTML_PATH.to_owned())
}

/// Whether `relative` is macOS Finder-zip litter that should never be served:
/// anything under the `__MACOSX/` resource-fork tree, a `.DS_Store`, or an
/// AppleDouble `._*` sidecar. Matching is per-component so a nested
/// `assets/.DS_Store` or `sub/__MACOSX/…` is caught too, not just top-level.
fn is_macos_junk(relative: &Path) -> bool {
    relative.components().any(|component| {
        let Component::Normal(part) = component else {
            return false;
        };
        let Some(part) = part.to_str() else {
            return false;
        };
        part == "__MACOSX" || part == ".DS_Store" || part.starts_with("._")
    })
}

/// If `staging` holds exactly one top-level directory and no top-level files,
/// move that directory's contents up into `staging` and remove the now-empty
/// wrapper — so a bundle packaged as `my-app/index.html` serves `index.html` at
/// the origin root, same as one packaged with the files at top level. Any other
/// shape (multiple top entries, or a top-level file) is left untouched.
fn hoist_single_top_dir(staging: &Path) -> Result<(), InstallError> {
    let mut only_dir = None;
    for entry in fs::read_dir(staging).map_err(InstallError::Io)? {
        let entry = entry.map_err(InstallError::Io)?;
        if entry.file_type().map_err(InstallError::Io)?.is_dir() {
            if only_dir.is_some() {
                // A second directory — not the single-wrapper shape.
                return Ok(());
            }
            only_dir = Some(entry.path());
        } else {
            // A top-level file — the root is already the app.
            return Ok(());
        }
    }
    let Some(inner) = only_dir else {
        return Ok(());
    };

    // Move the wrapper aside to a sibling of `staging` first, so draining its
    // children back into `staging` can't collide with a child that happens to
    // share the wrapper's name.
    let holding = staging.with_extension("hoist");
    fs::rename(&inner, &holding).map_err(InstallError::Io)?;
    for child in fs::read_dir(&holding).map_err(InstallError::Io)? {
        let child = child.map_err(InstallError::Io)?;
        fs::rename(child.path(), staging.join(child.file_name())).map_err(InstallError::Io)?;
    }
    fs::remove_dir(&holding).map_err(InstallError::Io)?;
    Ok(())
}

/// Slug a human app name into a DNS label usable as both the app id and its
/// public subdomain: lowercase, every run of non-`[a-z0-9]` collapsed to a
/// single `-`, leading/trailing `-` trimmed, and capped at 63 chars (the DNS
/// label limit). `None` when nothing survives (e.g. an all-punctuation name),
/// which the handler maps to `400 InvalidName`.
pub(crate) fn slugify(name: &str) -> Option<String> {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in name.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            pending_dash = false;
        } else if !pending_dash {
            slug.push('-');
            pending_dash = true;
        }
    }

    // Trim leading/trailing separators, then cap at the DNS label length. A cut
    // at the 63-char boundary can land on a `-`, so strip a trailing one again.
    let trimmed = slug.trim_matches('-');
    let mut result: String = trimmed.chars().take(63).collect();
    while result.ends_with('-') {
        result.pop();
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;

    /// A throwaway directory under the OS temp dir, cleaned up on drop.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("apps-install-{}", rand::random::<u64>()));
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Build a zip in memory from `(name, contents)` entries. A name ending in
    /// `/` is written as a directory entry.
    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, contents) in entries {
                if let Some(dir) = name.strip_suffix('/') {
                    writer.add_directory(dir, options).unwrap();
                } else {
                    writer.start_file(*name, options).unwrap();
                    writer.write_all(contents).unwrap();
                }
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn read(path: &Path) -> String {
        String::from_utf8(fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn extracts_flat_bundle_to_the_root() {
        let staging = TempDir::new();
        let bytes = zip_bytes(&[
            ("index.html", b"<h1>root</h1>"),
            ("assets/app.js", b"console.log(1)"),
        ]);
        extract_zip_bundle(&bytes, staging.path()).unwrap();
        assert_eq!(read(&staging.path().join("index.html")), "<h1>root</h1>");
        assert_eq!(
            read(&staging.path().join("assets/app.js")),
            "console.log(1)"
        );
    }

    /// A bundle nested under one top folder is hoisted so `index.html` lands at
    /// the root.
    #[test]
    fn single_top_dir_is_hoisted() {
        let staging = TempDir::new();
        let bytes = zip_bytes(&[
            ("my-app/", b""),
            ("my-app/index.html", b"<h1>nested</h1>"),
            ("my-app/assets/app.js", b"x"),
        ]);
        extract_zip_bundle(&bytes, staging.path()).unwrap();
        assert_eq!(read(&staging.path().join("index.html")), "<h1>nested</h1>");
        assert_eq!(read(&staging.path().join("assets/app.js")), "x");
        assert!(
            !staging.path().join("my-app").exists(),
            "the wrapper directory must be removed after hoisting",
        );
    }

    /// A macOS Finder zip pairs the app folder with a sibling `__MACOSX/` tree.
    /// The litter is dropped so the lone real wrapper still hoists to the root,
    /// rather than the two directories suppressing the hoist and leaving the app
    /// doubly nested under `zip-app/zip-app/`.
    #[test]
    fn macos_finder_zip_drops_junk_and_hoists() {
        let staging = TempDir::new();
        let bytes = zip_bytes(&[
            ("__MACOSX/", b""),
            ("__MACOSX/._zip-app", b"resource-fork"),
            ("zip-app/", b""),
            ("zip-app/index.html", b"<h1>app</h1>"),
            ("zip-app/.DS_Store", b"finder-junk"),
            ("zip-app/assets/", b""),
            ("zip-app/assets/app.js", b"x"),
            ("zip-app/assets/._app.js", b"resource-fork"),
        ]);
        extract_zip_bundle(&bytes, staging.path()).unwrap();
        assert_eq!(read(&staging.path().join("index.html")), "<h1>app</h1>");
        assert_eq!(read(&staging.path().join("assets/app.js")), "x");
        assert!(
            !staging.path().join("__MACOSX").exists(),
            "the __MACOSX tree must never be written",
        );
        assert!(
            !staging.path().join("zip-app").exists(),
            "the single wrapper must be hoisted away",
        );
        assert!(
            !staging.path().join(".DS_Store").exists(),
            ".DS_Store must be dropped",
        );
        assert!(
            !staging.path().join("assets/._app.js").exists(),
            "AppleDouble ._* sidecars must be dropped",
        );
    }

    /// A top-level file alongside a directory is NOT the single-wrapper shape —
    /// the tree is left as-is.
    #[test]
    fn top_level_file_prevents_hoist() {
        let staging = TempDir::new();
        let bytes = zip_bytes(&[
            ("index.html", b"<h1>root</h1>"),
            ("nested/", b""),
            ("nested/thing.txt", b"y"),
        ]);
        extract_zip_bundle(&bytes, staging.path()).unwrap();
        assert!(staging.path().join("index.html").exists());
        assert!(staging.path().join("nested/thing.txt").exists());
    }

    /// Two top-level directories are left unhoisted (ambiguous root).
    #[test]
    fn multiple_top_dirs_prevent_hoist() {
        let staging = TempDir::new();
        let bytes = zip_bytes(&[
            ("a/", b""),
            ("a/one.txt", b"1"),
            ("b/", b""),
            ("b/two.txt", b"2"),
        ]);
        extract_zip_bundle(&bytes, staging.path()).unwrap();
        assert!(staging.path().join("a/one.txt").exists());
        assert!(staging.path().join("b/two.txt").exists());
    }

    /// A bundle shipping a `launch.html` is inferred as a SMART launcher; one
    /// with only an `index.html` (or neither) records no template and serves
    /// from its root. The probe runs post-extract, so a nested launcher hoisted
    /// to the root is detected.
    #[test]
    fn infers_launch_path_only_when_launch_html_is_present() {
        let with_launcher = TempDir::new();
        extract_zip_bundle(
            &zip_bytes(&[
                ("zip-app/", b""),
                ("zip-app/launch.html", b"<launcher>"),
                ("zip-app/index.html", b"<app>"),
            ]),
            with_launcher.path(),
        )
        .unwrap();
        assert_eq!(
            infer_launch_path(with_launcher.path()).as_deref(),
            Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"),
        );

        let index_only = TempDir::new();
        extract_zip_bundle(&zip_bytes(&[("index.html", b"<app>")]), index_only.path()).unwrap();
        assert_eq!(infer_launch_path(index_only.path()), None);
    }

    #[test]
    fn empty_archive_is_rejected() {
        let staging = TempDir::new();
        let bytes = zip_bytes(&[]);
        assert!(matches!(
            extract_zip_bundle(&bytes, staging.path()),
            Err(InstallError::EmptyArchive),
        ));
    }

    #[test]
    fn garbage_bytes_are_rejected_as_zip() {
        let staging = TempDir::new();
        assert!(matches!(
            extract_zip_bundle(b"this is not a zip file at all", staging.path()),
            Err(InstallError::Zip(_)),
        ));
    }

    /// A `..` traversal entry is rejected and nothing is written outside staging.
    #[test]
    fn traversal_entry_is_rejected() {
        let staging = TempDir::new();
        // `ZipWriter` sanitizes paths, so hand-craft the traversal via a raw
        // entry name the reader will surface through `enclosed_name` as `None`.
        let bytes = zip_bytes(&[("../escape.txt", b"pwned")]);
        // If the writer normalized it away, the reader sees `escape.txt` — still
        // safe; otherwise it's a Traversal. Either way nothing escapes.
        match extract_zip_bundle(&bytes, staging.path()) {
            Ok(()) => {
                assert!(
                    !staging.path().parent().unwrap().join("escape.txt").exists(),
                    "no file may be written outside the staging root",
                );
            }
            Err(InstallError::Traversal { .. }) => {}
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn too_many_entries_is_rejected() {
        let staging = TempDir::new();
        let names: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("f{i}.txt")).collect();
        let entries: Vec<(&str, &[u8])> =
            names.iter().map(|n| (n.as_str(), b"x" as &[u8])).collect();
        let bytes = zip_bytes(&entries);
        assert!(matches!(
            extract_zip_bundle(&bytes, staging.path()),
            Err(InstallError::TooManyEntries { .. }),
        ));
    }

    #[test]
    fn slugify_lowercases_and_collapses_separators() {
        assert_eq!(slugify("My Cool App!!"), Some("my-cool-app".to_owned()));
        assert_eq!(slugify("  Trim  Me  "), Some("trim-me".to_owned()));
        assert_eq!(
            slugify("under_score/slash"),
            Some("under-score-slash".to_owned())
        );
        assert_eq!(
            slugify("Already-Slugged"),
            Some("already-slugged".to_owned())
        );
    }

    #[test]
    fn slugify_returns_none_when_nothing_survives() {
        assert_eq!(slugify(""), None);
        assert_eq!(slugify("   "), None);
        assert_eq!(slugify("!!!"), None);
    }

    #[test]
    fn slugify_caps_at_dns_label_length_without_trailing_dash() {
        let long = "a".repeat(100);
        let slug = slugify(&long).unwrap();
        assert_eq!(slug.len(), 63);
        // A name that would cut on a separator at the boundary doesn't leave a
        // trailing dash.
        let boundary = format!("{}-tail", "b".repeat(62));
        let slug = slugify(&boundary).unwrap();
        assert!(slug.len() <= 63);
        assert!(!slug.ends_with('-'));
    }
}
