//! Copying vendored self-hosted app builds into the runtime app-data directory
//! at host startup. The builds are gitignored (absent on a fresh clone / CI), so
//! the sync is a no-op when the source root is missing. See the "Seeding vendored
//! builds" section of `docs/Apps/Store and Install Explanation.md` for the
//! dev-overwrite vs. release-copy-if-missing model.

use std::fs;
use std::io;
use std::path::Path;

/// Mirror each top-level app directory under `source_root` into `dest_root`.
///
/// Only directories at the top level of `source_root` are considered (the
/// tracked `README.md` / `.gitignore` alongside them are skipped). For each,
/// when `overwrite` is `true` the destination copy is removed and rewritten;
/// when `false`, an existing destination is left untouched (copy-if-missing).
/// A missing or non-directory `source_root` is a no-op — the vendored builds are
/// gitignored, so they legitimately don't exist on a fresh clone or in CI.
///
/// # Errors
///
/// Returns the first [`io::Error`] from reading `source_root` or copying a file.
pub fn sync_vendored_self_hosted_apps(
    source_root: &Path,
    dest_root: &Path,
    overwrite: bool,
) -> io::Result<()> {
    if !source_root.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            // Skip the tracked README / .gitignore that sit beside the app dirs.
            continue;
        }
        let dest = dest_root.join(entry.file_name());
        if dest.exists() {
            if overwrite {
                fs::remove_dir_all(&dest)?;
            } else {
                continue;
            }
        }
        copy_dir_all(&entry.path(), &dest)?;
    }
    Ok(())
}

/// Recursively deep-copy `src` into `dest`, creating `dest` (and any missing
/// parents) first. Files are copied byte-for-byte; subdirectories recurse.
fn copy_dir_all(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory under the OS temp dir, cleaned up on drop.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("apps-seed-{}", rand::random::<u64>()));
            fs::create_dir_all(&dir).unwrap();
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

    fn write(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn read(root: &Path, rel: &str) -> String {
        String::from_utf8(fs::read(root.join(rel)).unwrap()).unwrap()
    }

    #[test]
    fn missing_source_is_a_noop() {
        let dest = TempDir::new();
        let missing = dest.path().join("does-not-exist");
        sync_vendored_self_hosted_apps(&missing, dest.path(), true).unwrap();
        sync_vendored_self_hosted_apps(&missing, dest.path(), false).unwrap();
    }

    /// The first-party apps build to their own `dist/`, so the vendored tree
    /// holds no `medication` / `web-trace` / `importer` folder — the
    /// `content_folder`s their original self-hosted seeds recorded — while the
    /// host's app-data can still hold a copy an older build synced. In both
    /// modes the sync copies only what the source has and leaves that stale
    /// destination folder exactly as it was.
    #[test]
    fn a_first_party_folder_absent_from_the_source_is_a_noop() {
        for overwrite in [true, false] {
            let source = TempDir::new();
            let dest = TempDir::new();
            write(source.path(), "patient-browser/index.html", "pb");
            write(source.path(), "README.md", "docs");
            write(dest.path(), "medication/index.html", "stale");

            sync_vendored_self_hosted_apps(source.path(), dest.path(), overwrite).unwrap();

            assert_eq!(read(dest.path(), "patient-browser/index.html"), "pb");
            assert_eq!(
                read(dest.path(), "medication/index.html"),
                "stale",
                "a folder the source no longer has is neither created nor removed",
            );
            for absent in ["web-trace", "importer"] {
                assert!(
                    !dest.path().join(absent).exists(),
                    "{absent} must not be created when the source has no such folder",
                );
            }
        }
    }

    #[test]
    fn copies_top_level_dirs_and_skips_files() {
        let source = TempDir::new();
        let dest = TempDir::new();
        write(source.path(), "patient-browser/index.html", "<h1>pb</h1>");
        write(source.path(), "patient-browser/assets/app.js", "x");
        // A tracked non-directory beside the app dirs must be skipped.
        write(source.path(), "README.md", "docs");

        sync_vendored_self_hosted_apps(source.path(), dest.path(), false).unwrap();
        assert_eq!(
            read(dest.path(), "patient-browser/index.html"),
            "<h1>pb</h1>"
        );
        assert_eq!(read(dest.path(), "patient-browser/assets/app.js"), "x");
        assert!(
            !dest.path().join("README.md").exists(),
            "top-level files must not be copied",
        );
    }

    #[test]
    fn overwrite_true_replaces_the_destination() {
        let source = TempDir::new();
        let dest = TempDir::new();
        write(source.path(), "app/index.html", "new");
        // A stale destination with an extra file the fresh source doesn't have.
        write(dest.path(), "app/index.html", "old");
        write(dest.path(), "app/stale.txt", "gone");

        sync_vendored_self_hosted_apps(source.path(), dest.path(), true).unwrap();
        assert_eq!(read(dest.path(), "app/index.html"), "new");
        assert!(
            !dest.path().join("app/stale.txt").exists(),
            "overwrite must remove the destination first, dropping stale files",
        );
    }

    #[test]
    fn overwrite_false_leaves_an_existing_destination_untouched() {
        let source = TempDir::new();
        let dest = TempDir::new();
        write(source.path(), "app/index.html", "new");
        write(dest.path(), "app/index.html", "user-edited");

        sync_vendored_self_hosted_apps(source.path(), dest.path(), false).unwrap();
        assert_eq!(
            read(dest.path(), "app/index.html"),
            "user-edited",
            "copy-if-missing must not clobber an existing app dir",
        );

        // A brand-new app dir is still copied even in copy-if-missing mode.
        write(source.path(), "fresh/index.html", "fresh");
        sync_vendored_self_hosted_apps(source.path(), dest.path(), false).unwrap();
        assert_eq!(read(dest.path(), "fresh/index.html"), "fresh");
    }
}
