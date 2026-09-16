//! Validating and writing a recorded archive into the app's `saved_data`
//! directory.
//!
//! The file name arrives from the web side, so it is untrusted: every check
//! runs before any filesystem call, and a rejected name leaves the
//! directory untouched ([Review Standards][rs] rule 5, "gate before side
//! effects").
//!
//! [rs]: ../../../../docs/Agents/Review%20Standards%20Reference.md

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// The folder, under the app data directory, that user-visible artifacts are
/// written to. Join it through [`saved_data_dir`], not by hand.
pub const SAVED_DATA_DIR_NAME: &str = "saved_data";

/// The longest file name accepted, in bytes. The producer
/// (`recordingFileName` in `har-recorder-core`) trims its host component to
/// the same bound, so a name it built is never rejected for length.
pub const MAX_FILE_NAME_LENGTH: usize = 200;

/// The extension every saved recording carries.
pub const HAR_EXTENSION: &str = ".har";

/// Where saved artifacts live: `<app data dir>/saved_data`.
pub fn saved_data_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SAVED_DATA_DIR_NAME)
}

/// Why a save did not happen.
#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    /// The requested name is not one safe path segment ending in `.har`.
    /// Carries the reason only — the host echoes the name back separately.
    #[error("invalid file name: {0}")]
    InvalidFileName(String),
    /// Something already occupies the target path. With timestamped names a
    /// collision means something is wrong, so refusing beats clobbering.
    #[error("a file already exists at {0}")]
    AlreadyExists(PathBuf),
    /// The directory could not be created, or the bytes could not be
    /// written or moved into place.
    #[error("could not write the archive: {0}")]
    Io(#[from] io::Error),
}

/// Rejects any name that is not one safe path segment naming a `.har` file.
///
/// Accepts exactly what `recordingFileName` produces: 1..=[`MAX_FILE_NAME_LENGTH`]
/// bytes of `[A-Za-z0-9._-]`, no leading `.`, ending in `.har`. The charset is
/// an allowlist, so separators and control bytes are out by construction; the
/// explicit checks exist only to name the failure in the user-visible message.
pub fn validate_file_name(name: &str) -> Result<(), SaveError> {
    let invalid = |reason: &str| Err(SaveError::InvalidFileName(reason.to_owned()));

    if name.is_empty() {
        return invalid("the name is empty");
    }
    if name.len() > MAX_FILE_NAME_LENGTH {
        return invalid(&format!(
            "the name is longer than {MAX_FILE_NAME_LENGTH} bytes"
        ));
    }
    if name == "." || name == ".." {
        return invalid("the name is a directory reference");
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return invalid("the name is not one path segment");
    }
    if !name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return invalid("the name holds characters outside [A-Za-z0-9._-]");
    }
    if name.starts_with('.') {
        return invalid("the name starts with a dot");
    }
    if !name.ends_with(HAR_EXTENSION) || name.len() == HAR_EXTENSION.len() {
        return invalid("the name does not end in .har");
    }
    Ok(())
}

/// Distinguishes concurrent saves within one process; the pid distinguishes
/// them across processes. Only the temporary name needs it.
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Writes `text` to `<saved_data_dir>/<file_name>` and returns the path it
/// wrote.
///
/// The name is validated before the directory is created, so a rejected save
/// leaves no trace. The bytes land in a sibling temporary file — removed on
/// every failure path — and are renamed into place, so no reader sees a
/// half-written archive and a crash mid-write leaves no truncated `.har`.
///
/// An existing target is refused ([`SaveError::AlreadyExists`]) rather than
/// overwritten. Check and rename are two syscalls, so this guards against the
/// ordinary repeat, not against a racing second writer.
pub fn save_har(saved_data_dir: &Path, file_name: &str, text: &str) -> Result<PathBuf, SaveError> {
    validate_file_name(file_name)?;

    fs::create_dir_all(saved_data_dir)?;

    let target = saved_data_dir.join(file_name);
    if target.try_exists()? {
        return Err(SaveError::AlreadyExists(target));
    }

    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = saved_data_dir.join(format!(
        ".{file_name}.tmp-{}-{sequence}",
        std::process::id()
    ));

    if let Err(error) = fs::write(&temporary, text) {
        let _ = fs::remove_file(&temporary);
        return Err(SaveError::Io(error));
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(SaveError::Io(error));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Stand-in archive text for the tests that only care about the name.
    const EMPTY_ARCHIVE: &str = "{}";

    /// Every entry currently in `dir`, sorted, as plain strings.
    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("read dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn saved_data_dir_is_the_one_folder_name() {
        assert_eq!(
            saved_data_dir(Path::new("/home/u/.wildflower")),
            PathBuf::from("/home/u/.wildflower/saved_data")
        );
        assert_eq!(SAVED_DATA_DIR_NAME, "saved_data");
    }

    #[test]
    fn a_valid_save_writes_the_exact_bytes_and_returns_its_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let text = r#"{"log":{"version":"1.2","entries":[]}}"#;

        let path = save_har(dir.path(), "2026-01-02T03-04-05Z-example.test.har", text)
            .expect("save succeeds");

        assert_eq!(
            path,
            dir.path().join("2026-01-02T03-04-05Z-example.test.har")
        );
        assert_eq!(fs::read_to_string(&path).expect("read back"), text);
        assert_eq!(
            entries(dir.path()),
            vec!["2026-01-02T03-04-05Z-example.test.har".to_owned()],
            "a successful save leaves no temporary file behind"
        );
    }

    #[test]
    fn the_directory_is_created_on_demand() {
        let root = tempfile::tempdir().expect("tempdir");
        let target_dir = saved_data_dir(root.path());

        let path = save_har(&target_dir, "a.har", "{}").expect("save succeeds");

        assert!(path.starts_with(&target_dir));
        assert!(target_dir.is_dir());
    }

    #[test]
    fn rejected_names_write_nothing_at_all() {
        let cases = [
            ("../escape.har", "parent traversal"),
            ("nested/escape.har", "a separator"),
            ("nested\\escape.har", "a windows separator"),
            ("..", "a directory reference"),
            (".", "a directory reference"),
            (".hidden.har", "a leading dot"),
            (".har", "no stem"),
            ("notes.txt", "the wrong extension"),
            ("", "an empty name"),
            ("archive.har\0", "an embedded NUL"),
            ("réçord.har", "non-ascii"),
            ("spaced name.har", "a space"),
        ];
        for (name, why) in cases {
            let dir = tempfile::tempdir().expect("tempdir");
            let error = save_har(dir.path(), name, "{}")
                .expect_err(&format!("expected {name:?} to be rejected ({why})"));
            assert!(
                matches!(error, SaveError::InvalidFileName(_)),
                "{name:?} ({why}) produced {error:?}"
            );
            assert!(
                entries(dir.path()).is_empty(),
                "{name:?} ({why}) left files behind: {:?}",
                entries(dir.path())
            );
        }
    }

    #[test]
    fn an_over_long_name_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stem = "a".repeat(MAX_FILE_NAME_LENGTH - HAR_EXTENSION.len() + 1);
        let name = format!("{stem}{HAR_EXTENSION}");
        assert_eq!(name.len(), MAX_FILE_NAME_LENGTH + 1);

        let error = save_har(dir.path(), &name, "{}").expect_err("expected a length rejection");

        assert!(matches!(error, SaveError::InvalidFileName(_)), "{error:?}");
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn a_name_of_exactly_the_maximum_length_is_accepted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stem = "a".repeat(MAX_FILE_NAME_LENGTH - HAR_EXTENSION.len());
        let name = format!("{stem}{HAR_EXTENSION}");
        assert_eq!(name.len(), MAX_FILE_NAME_LENGTH);

        save_har(dir.path(), &name, "{}").expect("save succeeds");
    }

    #[test]
    fn an_existing_target_is_refused_and_left_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let existing = dir.path().join("a.har");
        fs::write(&existing, "original").expect("seed");

        let error = save_har(dir.path(), "a.har", "replacement").expect_err("expected a refusal");

        assert!(matches!(error, SaveError::AlreadyExists(ref path) if *path == existing));
        assert_eq!(
            fs::read_to_string(&existing).expect("read back"),
            "original"
        );
        assert_eq!(
            entries(dir.path()),
            vec!["a.har".to_owned()],
            "a refused save leaves no temporary file behind"
        );
    }

    /// A directory is an occupant like any other, and the existence gate has
    /// to catch it before a temporary file is created.
    #[test]
    fn a_directory_at_the_target_path_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("a.har")).expect("mkdir");

        let error = save_har(dir.path(), "a.har", "{}").expect_err("expected a refusal");

        assert!(matches!(error, SaveError::AlreadyExists(_)), "{error:?}");
        assert_eq!(entries(dir.path()), vec!["a.har".to_owned()]);
    }

    #[test]
    fn an_unwritable_directory_surfaces_as_io() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A file sits where the directory would go, so it cannot be created.
        let occupied = dir.path().join(SAVED_DATA_DIR_NAME);
        fs::write(&occupied, "not a directory").expect("seed");

        let error = save_har(&saved_data_dir(dir.path()), "a.har", "{}")
            .expect_err("expected create_dir_all to fail");

        assert!(matches!(error, SaveError::Io(_)), "{error:?}");
    }

    #[test]
    fn two_saves_into_one_directory_both_land() {
        let dir = tempfile::tempdir().expect("tempdir");
        save_har(dir.path(), "one.har", "1").expect("first");
        save_har(dir.path(), "two.har", "2").expect("second");
        assert_eq!(
            entries(dir.path()),
            vec!["one.har".to_owned(), "two.har".to_owned()]
        );
    }

    /// The host forwards this `Display` on `HarSaveFailed` — an empty one
    /// would ship a blank banner.
    #[test]
    fn save_errors_describe_themselves() {
        let rejected =
            validate_file_name("../x.har").expect_err("expected a traversal to be rejected");
        assert!(
            rejected.to_string().contains("invalid file name"),
            "{rejected}"
        );
        assert!(SaveError::AlreadyExists(PathBuf::from("/tmp/a.har"))
            .to_string()
            .contains("/tmp/a.har"));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// The host must never reject a name its own web side built, so
        /// everything the producer's shape can emit is accepted.
        #[test]
        fn producer_shaped_names_are_accepted(
            stem in "[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}"
        ) {
            let name = format!("{stem}{HAR_EXTENSION}");
            prop_assert!(name.len() <= MAX_FILE_NAME_LENGTH);
            prop_assert!(validate_file_name(&name).is_ok(), "rejected {name:?}");
        }

        /// A separator anywhere is rejected, whichever side of it `.har`
        /// falls on.
        #[test]
        fn names_holding_a_separator_are_rejected(
            head in "[A-Za-z0-9_-]{0,40}",
            separator in prop::sample::select(vec!["/", "\\", "\0"]),
            tail in "[A-Za-z0-9._-]{0,40}"
        ) {
            let name = format!("{head}{separator}{tail}{HAR_EXTENSION}");
            prop_assert!(
                matches!(validate_file_name(&name), Err(SaveError::InvalidFileName(_))),
                "accepted {name:?}"
            );
        }

        /// A separator-bearing name must never reach the filesystem, so
        /// nothing is created anywhere — least of all outside the directory
        /// it was aimed at.
        #[test]
        fn traversal_names_create_nothing(
            depth in 1usize..4,
            stem in "[A-Za-z0-9_-]{1,12}"
        ) {
            let root = tempfile::tempdir().expect("tempdir");
            let inner = root.path().join("inner");
            fs::create_dir(&inner).expect("mkdir");
            let name = format!("{}{stem}{HAR_EXTENSION}", "../".repeat(depth));

            let saved = save_har(&inner, &name, EMPTY_ARCHIVE);
            prop_assert!(saved.is_err());
            prop_assert!(entries(&inner).is_empty());
            prop_assert_eq!(entries(root.path()), vec!["inner".to_owned()]);
        }
    }
}
