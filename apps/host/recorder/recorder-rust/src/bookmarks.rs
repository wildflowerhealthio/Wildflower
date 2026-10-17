//! [`JsonBookmarks`]: the Recorder's bookmarks, kept in
//! `<data root>/recorder-bookmarks.json`.
//!
//! The file is `{"version": 1, "bookmarks": [...]}`, each bookmark's fields
//! in camelCase. A bookmark is keyed by its URL; there are no ids. Its version
//! is read before anything else, and any version but [`FORMAT_VERSION`] is
//! [`BookmarkError::UnsupportedVersion`]: the file is neither read nor
//! overwritten.
//!
//! A missing file reads as [`FIRST_RUN_BOOKMARKS`], and nothing is written
//! until the first change, which writes the seeds with the change applied. A
//! file that exists is never reseeded, even when its list is empty.
//!
//! Every change rewrites the whole file through a [`StagedBookmarksFile`]:
//! the new document is written to `.recorder-bookmarks.json.tmp` beside it and
//! fsynced, then renamed over `recorder-bookmarks.json`, and the directory
//! fsynced. A crash before the rename leaves the previous file whole.
//!
//! The store is clock-free: [`JsonBookmarks::recorded`] takes the instant to
//! stamp, which the host's command reads from the clock.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The bookmarks' file name in the data root.
pub const BOOKMARKS_FILE_NAME: &str = "recorder-bookmarks.json";

/// The `recorder-bookmarks.json` format version this build reads and writes.
const FORMAT_VERSION: u64 = 1;

/// The bookmarks a missing file reads as, each `(name, url)` and never
/// recorded: the pharmacy and lab portals the Recorder was first used with.
pub const FIRST_RUN_BOOKMARKS: [(&str, &str); 4] = [
    (
        "Rexall prescriptions",
        "https://app.letsbewell.ca/health/prescriptions",
    ),
    (
        "Shoppers prescriptions",
        "https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/",
    ),
    (
        "LifeLabs reports",
        "https://www.on.mycarecompass.lifelabs.com/reports",
    ),
    (
        "TELUS Health Virtual Care",
        "https://virtualcare.telushealth.com/",
    ),
];

/// A page the user records from, and when a recording last started from it.
///
/// Wire: `{"name":"LifeLabs reports","url":"https://…","lastRecordedAt":"2026-09-25T14:02:11Z"}`,
/// or `"lastRecordedAt":null` when never recorded, pinned by
/// `recorder-wire-golden.json`, which `recorder-core-js`'s `Bookmark` reads
/// too. The same shape is stored in the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bookmark {
    /// What the page calls it.
    pub name: String,
    /// The page's `http(s)` URL, normalised by the page: the bookmark's key.
    pub url: String,
    /// When a recording last started from exactly this URL.
    pub last_recorded_at: Option<DateTime<Utc>>,
}

impl Bookmark {
    fn first_run((name, url): (&str, &str)) -> Self {
        Self {
            name: name.to_owned(),
            url: url.to_owned(),
            last_recorded_at: None,
        }
    }
}

/// `recorder_bookmark_add`'s arguments.
///
/// Wire: `{"name":"LifeLabs reports","url":"https://…"}`, pinned by
/// `recorder-wire-golden.json`'s `commandArgs`. The command's parameters are
/// these fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookmarkAddArgs {
    pub name: String,
    pub url: String,
}

/// `recorder_bookmark_rename`'s arguments: the bookmark's URL and its new name.
///
/// Wire: `{"url":"https://…","name":"LifeLabs results"}`, pinned by
/// `recorder-wire-golden.json`'s `commandArgs`. The command's parameters are
/// these fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookmarkRenameArgs {
    pub url: String,
    pub name: String,
}

/// The arguments of `recorder_bookmark_remove` and
/// `recorder_bookmark_recorded`: the bookmark's URL.
///
/// Wire: `{"url":"https://…"}`, pinned by `recorder-wire-golden.json`'s
/// `commandArgs`. The commands' parameter is this field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookmarkUrlArgs {
    pub url: String,
}

/// Why a bookmark change, or reading the bookmarks, was refused. `Display`
/// is the message the Recorder page shows.
#[derive(Debug, thiserror::Error)]
pub enum BookmarkError {
    /// The name is empty or only whitespace.
    #[error("a bookmark needs a name")]
    EmptyName,
    /// The URL isn't `http://` or `https://`, the only pages the Recorder
    /// opens.
    #[error("{url} isn't an http:// or https:// URL")]
    NotHttpUrl { url: String },
    /// A bookmark with this URL exists.
    #[error("{url} is already bookmarked")]
    AlreadyBookmarked { url: String },
    /// No bookmark has this URL.
    #[error("{url} isn't bookmarked")]
    NotBookmarked { url: String },
    /// The file is a version this build doesn't read. It is left as it is.
    #[error(
        "{BOOKMARKS_FILE_NAME} is version {version}, which this version of Wildflower can't read"
    )]
    UnsupportedVersion { version: u64 },
    /// The file couldn't be read, parsed or replaced.
    #[error("{context}: {source}")]
    Storage {
        context: &'static str,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}

impl BookmarkError {
    fn storage(
        context: &'static str,
        source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
    ) -> Self {
        Self::Storage {
            context,
            source: source.into(),
        }
    }
}

/// The bookmarks over `<data root>/recorder-bookmarks.json`.
pub struct JsonBookmarks {
    data_root: PathBuf,
    path: PathBuf,
    /// Held across each read-modify-write, so two changes in this process
    /// can't each write over the other's.
    write_lock: Mutex<()>,
}

impl JsonBookmarks {
    /// The bookmarks in `data_root`. Nothing is read or created until they're
    /// used.
    #[must_use]
    pub fn in_data_root(data_root: &Path) -> Self {
        Self {
            data_root: data_root.to_owned(),
            path: data_root.join(BOOKMARKS_FILE_NAME),
            write_lock: Mutex::new(()),
        }
    }

    /// Every bookmark, in the file's order: the [`FIRST_RUN_BOOKMARKS`] when
    /// there is no file.
    pub fn read_all(&self) -> Result<Vec<Bookmark>, BookmarkError> {
        Ok(self.read_document()?.bookmarks)
    }

    /// Bookmark `url` as `name`, after the others. Returns every bookmark.
    pub fn add(&self, name: &str, url: &str) -> Result<Vec<Bookmark>, BookmarkError> {
        let name = checked_name(name)?;
        let url = checked_url(url)?;
        self.change_bookmarks(|bookmarks| {
            if bookmarks.iter().any(|bookmark| bookmark.url == url) {
                return Err(BookmarkError::AlreadyBookmarked { url });
            }
            bookmarks.push(Bookmark {
                name,
                url,
                last_recorded_at: None,
            });
            Ok(())
        })
    }

    /// Call the bookmark at `url` `name`. Returns every bookmark.
    pub fn rename(&self, url: &str, name: &str) -> Result<Vec<Bookmark>, BookmarkError> {
        let name = checked_name(name)?;
        self.change_bookmarks(|bookmarks| {
            bookmarked_mut(bookmarks, url)?.name = name;
            Ok(())
        })
    }

    /// Drop the bookmark at `url`. Returns every bookmark left.
    pub fn remove(&self, url: &str) -> Result<Vec<Bookmark>, BookmarkError> {
        self.change_bookmarks(|bookmarks| {
            let position = bookmarks
                .iter()
                .position(|bookmark| bookmark.url == url)
                .ok_or_else(|| BookmarkError::NotBookmarked {
                    url: url.to_owned(),
                })?;
            bookmarks.remove(position);
            Ok(())
        })
    }

    /// Stamp the bookmark whose URL is exactly `url` as recorded `at`.
    /// Returns every bookmark.
    ///
    /// A URL that isn't bookmarked changes nothing and writes nothing: a
    /// recording can start from any page.
    pub fn recorded(&self, url: &str, at: DateTime<Utc>) -> Result<Vec<Bookmark>, BookmarkError> {
        let _guard = self.write_lock.lock();
        let mut document = self.read_document()?;
        let Some(bookmark) = document
            .bookmarks
            .iter_mut()
            .find(|bookmark| bookmark.url == url)
        else {
            return Ok(document.bookmarks);
        };
        bookmark.last_recorded_at = Some(at);
        self.stage(&document)?.commit()?;
        Ok(document.bookmarks)
    }

    fn read_document(&self) -> Result<BookmarksDocument, BookmarkError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(BookmarksDocument::first_run())
            }
            Err(error) => {
                return Err(BookmarkError::storage(
                    "reading recorder-bookmarks.json",
                    error,
                ))
            }
        };
        let VersionProbe { version } = serde_json::from_slice(&bytes).map_err(|error| {
            BookmarkError::storage("reading recorder-bookmarks.json's version", error)
        })?;
        if version != FORMAT_VERSION {
            return Err(BookmarkError::UnsupportedVersion { version });
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| BookmarkError::storage("parsing recorder-bookmarks.json", error))
    }

    /// Read the bookmarks, apply `change`, and replace the file with the
    /// result. Returns every bookmark after the change.
    fn change_bookmarks(
        &self,
        change: impl FnOnce(&mut Vec<Bookmark>) -> Result<(), BookmarkError>,
    ) -> Result<Vec<Bookmark>, BookmarkError> {
        let _guard = self.write_lock.lock();
        let mut document = self.read_document()?;
        change(&mut document.bookmarks)?;
        self.stage(&document)?.commit()?;
        Ok(document.bookmarks)
    }

    /// Write `document` to the temporary file and fsync it, without touching
    /// `recorder-bookmarks.json`.
    fn stage(&self, document: &BookmarksDocument) -> Result<StagedBookmarksFile, BookmarkError> {
        let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
            BookmarkError::storage("serialising recorder-bookmarks.json", error)
        })?;
        fs::create_dir_all(&self.data_root)
            .map_err(|error| BookmarkError::storage("creating the data root", error))?;
        let temp_path = self.data_root.join(format!(".{BOOKMARKS_FILE_NAME}.tmp"));
        write_synced(&temp_path, &bytes).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            BookmarkError::storage("writing the new recorder-bookmarks.json", error)
        })?;
        Ok(StagedBookmarksFile {
            temp_path,
            data_root: self.data_root.clone(),
            path: self.path.clone(),
        })
    }
}

/// `name`, unless it is empty or only whitespace.
fn checked_name(name: &str) -> Result<String, BookmarkError> {
    if name.trim().is_empty() {
        return Err(BookmarkError::EmptyName);
    }
    Ok(name.to_owned())
}

/// `url`, if it is `http://` or `https://`: the rule `recorder-core-js`'s
/// `HttpUrl` applies, so the page and the host refuse the same URLs.
fn checked_url(url: &str) -> Result<String, BookmarkError> {
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(url.to_owned())
    } else {
        Err(BookmarkError::NotHttpUrl {
            url: url.to_owned(),
        })
    }
}

/// The bookmark whose URL is `url`.
fn bookmarked_mut<'a>(
    bookmarks: &'a mut [Bookmark],
    url: &str,
) -> Result<&'a mut Bookmark, BookmarkError> {
    bookmarks
        .iter_mut()
        .find(|bookmark| bookmark.url == url)
        .ok_or_else(|| BookmarkError::NotBookmarked {
            url: url.to_owned(),
        })
}

/// A new `recorder-bookmarks.json`, written and fsynced beside the live one
/// but not yet in its place.
#[must_use = "the bookmarks are unchanged until the staged file is committed"]
struct StagedBookmarksFile {
    temp_path: PathBuf,
    data_root: PathBuf,
    path: PathBuf,
}

impl StagedBookmarksFile {
    /// Rename the staged file over `recorder-bookmarks.json` and fsync the
    /// directory, so the rename itself survives a crash.
    fn commit(self) -> Result<(), BookmarkError> {
        if let Err(error) = fs::rename(&self.temp_path, &self.path) {
            let _ = fs::remove_file(&self.temp_path);
            return Err(BookmarkError::storage(
                "replacing recorder-bookmarks.json",
                error,
            ));
        }
        sync_directory(&self.data_root)
            .map_err(|error| BookmarkError::storage("syncing the data root", error))
    }
}

/// Create or truncate `path`, write `bytes` and fsync.
fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> io::Result<()> {
    fs::File::open(directory)?.sync_all()
}

/// Windows can't open a directory as a file to fsync it; the rename is as
/// durable as the filesystem makes it.
#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> io::Result<()> {
    Ok(())
}

/// Only the version, read first so an unknown version is reported as such
/// instead of as whatever its fields fail to parse as.
#[derive(Deserialize)]
struct VersionProbe {
    version: u64,
}

/// The file's whole document.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BookmarksDocument {
    version: u64,
    bookmarks: Vec<Bookmark>,
}

impl BookmarksDocument {
    fn first_run() -> Self {
        Self {
            version: FORMAT_VERSION,
            bookmarks: FIRST_RUN_BOOKMARKS.map(Bookmark::first_run).to_vec(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    const LIFELABS: &str = "https://www.on.mycarecompass.lifelabs.com/reports";
    const SHOPPERS: &str = "https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/";

    fn bookmarks() -> (tempfile::TempDir, JsonBookmarks) {
        let data_root = tempfile::tempdir().expect("tempdir");
        let bookmarks = JsonBookmarks::in_data_root(data_root.path());
        (data_root, bookmarks)
    }

    fn file_path(data_root: &tempfile::TempDir) -> PathBuf {
        data_root.path().join(BOOKMARKS_FILE_NAME)
    }

    fn file_text(data_root: &tempfile::TempDir) -> String {
        fs::read_to_string(file_path(data_root)).expect("the bookmarks file")
    }

    fn write_file(data_root: &tempfile::TempDir, text: &str) {
        fs::write(file_path(data_root), text).expect("write the bookmarks file");
    }

    fn seeds() -> Vec<Bookmark> {
        FIRST_RUN_BOOKMARKS.map(Bookmark::first_run).to_vec()
    }

    fn bookmark(name: &str, url: &str) -> Bookmark {
        Bookmark {
            name: name.to_owned(),
            url: url.to_owned(),
            last_recorded_at: None,
        }
    }

    fn at(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 25, hour, 2, 11).unwrap()
    }

    #[test]
    fn a_missing_file_reads_as_the_seeds_and_writes_nothing() {
        let (data_root, bookmarks) = bookmarks();

        let read = bookmarks.read_all().unwrap();

        assert_eq!(
            read.iter()
                .map(|bookmark| bookmark.name.as_str())
                .collect::<Vec<_>>(),
            [
                "Rexall prescriptions",
                "Shoppers prescriptions",
                "LifeLabs reports",
                "TELUS Health Virtual Care",
            ]
        );
        assert!(read
            .iter()
            .all(|bookmark| bookmark.last_recorded_at.is_none()));
        assert!(!file_path(&data_root).exists());
    }

    #[test]
    fn the_first_change_writes_the_seeds_plus_the_change() {
        let (data_root, bookmarks) = bookmarks();

        let changed = bookmarks.add("Lab", "https://lab.example/").unwrap();

        let mut expected = seeds();
        expected.push(bookmark("Lab", "https://lab.example/"));
        assert_eq!(changed, expected);
        assert_eq!(
            JsonBookmarks::in_data_root(data_root.path())
                .read_all()
                .unwrap(),
            expected
        );
    }

    #[test]
    fn an_existing_empty_list_is_not_reseeded() {
        let (data_root, bookmarks) = bookmarks();
        write_file(&data_root, r#"{"version": 1, "bookmarks": []}"#);

        assert_eq!(bookmarks.read_all().unwrap(), vec![]);
        assert_eq!(
            bookmarks.add("Lab", "https://lab.example/").unwrap(),
            vec![bookmark("Lab", "https://lab.example/")]
        );
    }

    #[test]
    fn removing_every_bookmark_stays_removed() {
        let (data_root, bookmarks) = bookmarks();

        for (_, url) in FIRST_RUN_BOOKMARKS {
            bookmarks.remove(url).unwrap();
        }

        assert_eq!(
            JsonBookmarks::in_data_root(data_root.path())
                .read_all()
                .unwrap(),
            vec![]
        );
    }

    #[test]
    fn add_rename_and_remove_round_trip_through_the_file() {
        let (data_root, bookmarks) = bookmarks();
        write_file(&data_root, r#"{"version": 1, "bookmarks": []}"#);
        let reopened = || {
            JsonBookmarks::in_data_root(data_root.path())
                .read_all()
                .unwrap()
        };

        bookmarks.add("Lab", "https://lab.example/").unwrap();
        bookmarks
            .add("Pharmacy", "https://pharmacy.example/")
            .unwrap();
        assert_eq!(
            reopened(),
            vec![
                bookmark("Lab", "https://lab.example/"),
                bookmark("Pharmacy", "https://pharmacy.example/"),
            ]
        );

        bookmarks
            .rename("https://lab.example/", "Lab results")
            .unwrap();
        assert_eq!(
            reopened(),
            vec![
                bookmark("Lab results", "https://lab.example/"),
                bookmark("Pharmacy", "https://pharmacy.example/"),
            ]
        );

        bookmarks.remove("https://lab.example/").unwrap();
        assert_eq!(
            reopened(),
            vec![bookmark("Pharmacy", "https://pharmacy.example/")]
        );
    }

    #[test]
    fn each_refusal_writes_nothing() {
        let (data_root, bookmarks) = bookmarks();
        write_file(
            &data_root,
            &format!(
                r#"{{"version": 1, "bookmarks": [{{"name": "LifeLabs", "url": "{LIFELABS}", "lastRecordedAt": null}}]}}"#
            ),
        );
        let before = file_text(&data_root);

        assert!(matches!(
            bookmarks.add("Again", LIFELABS),
            Err(BookmarkError::AlreadyBookmarked { url }) if url == LIFELABS
        ));
        assert!(matches!(
            bookmarks.add("Files", "file:///etc/passwd"),
            Err(BookmarkError::NotHttpUrl { url }) if url == "file:///etc/passwd"
        ));
        assert!(matches!(
            bookmarks.add("Script", "javascript:alert(1)"),
            Err(BookmarkError::NotHttpUrl { .. })
        ));
        assert!(matches!(
            bookmarks.add("", "https://lab.example/"),
            Err(BookmarkError::EmptyName)
        ));
        assert!(matches!(
            bookmarks.add("   ", "https://lab.example/"),
            Err(BookmarkError::EmptyName)
        ));
        assert!(matches!(
            bookmarks.rename(LIFELABS, ""),
            Err(BookmarkError::EmptyName)
        ));
        assert!(matches!(
            bookmarks.rename("https://lab.example/", "Lab"),
            Err(BookmarkError::NotBookmarked { url }) if url == "https://lab.example/"
        ));
        assert!(matches!(
            bookmarks.remove("https://lab.example/"),
            Err(BookmarkError::NotBookmarked { .. })
        ));
        assert_eq!(file_text(&data_root), before);
    }

    #[test]
    fn a_refusal_says_why_in_words_the_page_shows() {
        assert_eq!(
            BookmarkError::AlreadyBookmarked {
                url: LIFELABS.to_owned()
            }
            .to_string(),
            format!("{LIFELABS} is already bookmarked")
        );
        assert_eq!(
            BookmarkError::EmptyName.to_string(),
            "a bookmark needs a name"
        );
    }

    #[test]
    fn recorded_stamps_only_the_exactly_matching_url() {
        let (data_root, bookmarks) = bookmarks();
        write_file(&data_root, r#"{"version": 1, "bookmarks": []}"#);
        bookmarks.add("Reports", LIFELABS).unwrap();
        bookmarks
            .add(
                "Appointments",
                "https://www.on.mycarecompass.lifelabs.com/appointments",
            )
            .unwrap();

        let stamped = bookmarks.recorded(LIFELABS, at(14)).unwrap();

        assert_eq!(
            stamped,
            vec![
                Bookmark {
                    last_recorded_at: Some(at(14)),
                    ..bookmark("Reports", LIFELABS)
                },
                bookmark(
                    "Appointments",
                    "https://www.on.mycarecompass.lifelabs.com/appointments"
                ),
            ]
        );
        assert_eq!(bookmarks.read_all().unwrap(), stamped);

        // A later recording moves the stamp on.
        let restamped = bookmarks.recorded(LIFELABS, at(16)).unwrap();
        assert_eq!(restamped[0].last_recorded_at, Some(at(16)));
    }

    #[test]
    fn recording_an_unknown_url_changes_and_writes_nothing() {
        let (data_root, bookmarks) = bookmarks();

        assert_eq!(
            bookmarks.recorded("https://lab.example/", at(14)).unwrap(),
            seeds()
        );
        assert!(!file_path(&data_root).exists());

        bookmarks.remove(SHOPPERS).unwrap();
        let before = file_text(&data_root);
        bookmarks.recorded(SHOPPERS, at(14)).unwrap();
        assert_eq!(file_text(&data_root), before);
    }

    #[test]
    fn an_unsupported_version_is_refused_and_left_byte_identical() {
        let (data_root, bookmarks) = bookmarks();
        let future = r#"{"version": 2, "bookmarks": [], "folders": []}"#;
        write_file(&data_root, future);

        assert!(matches!(
            bookmarks.read_all(),
            Err(BookmarkError::UnsupportedVersion { version: 2 })
        ));
        assert!(matches!(
            bookmarks.add("Lab", "https://lab.example/"),
            Err(BookmarkError::UnsupportedVersion { version: 2 })
        ));
        assert!(matches!(
            bookmarks.recorded(LIFELABS, at(14)),
            Err(BookmarkError::UnsupportedVersion { version: 2 })
        ));
        assert_eq!(file_text(&data_root), future);
    }

    #[test]
    fn an_unreadable_file_is_refused() {
        let (data_root, bookmarks) = bookmarks();
        write_file(&data_root, "not json");

        assert!(matches!(
            bookmarks.read_all(),
            Err(BookmarkError::Storage { .. })
        ));
        assert!(matches!(
            bookmarks.add("Lab", "https://lab.example/"),
            Err(BookmarkError::Storage { .. })
        ));
        assert_eq!(file_text(&data_root), "not json");
    }

    #[test]
    fn a_failed_write_leaves_the_previous_file_whole() {
        let (data_root, bookmarks) = bookmarks();
        bookmarks.add("Lab", "https://lab.example/").unwrap();
        let before = file_text(&data_root);
        // A directory where the temporary file goes, so writing it fails.
        fs::create_dir(data_root.path().join(format!(".{BOOKMARKS_FILE_NAME}.tmp"))).unwrap();

        assert!(matches!(
            bookmarks.add("Pharmacy", "https://pharmacy.example/"),
            Err(BookmarkError::Storage { .. })
        ));

        assert_eq!(file_text(&data_root), before);
    }

    #[test]
    fn a_crash_before_the_rename_leaves_the_previous_file() {
        let (data_root, bookmarks) = bookmarks();
        bookmarks.add("Lab", "https://lab.example/").unwrap();
        let before = file_text(&data_root);

        let staged = bookmarks
            .stage(&BookmarksDocument {
                version: FORMAT_VERSION,
                bookmarks: vec![],
            })
            .unwrap();
        assert!(staged.temp_path.exists());
        // The process dies here: the staged file is never committed.
        drop(staged);

        assert_eq!(file_text(&data_root), before);

        // The next change writes over the leftover temporary file.
        bookmarks.remove("https://lab.example/").unwrap();
        assert!(!bookmarks
            .read_all()
            .unwrap()
            .iter()
            .any(|bookmark| bookmark.url == "https://lab.example/"));
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../recorder-wire-golden.json")).expect("golden")
    }

    /// `value` decoded as `T` and encoded again.
    fn round_trip<T: Serialize + DeserializeOwned>(value: &Value) -> Value {
        let decoded: T = serde_json::from_value(value.clone()).expect("decodes");
        serde_json::to_value(&decoded).expect("serialize")
    }

    /// The page decodes the same golden answer, so the two can't drift.
    #[test]
    fn the_bookmarks_answer_matches_the_golden_file() {
        let answer = &golden()["commands"]["recorder_bookmarks"];

        assert_eq!(round_trip::<Vec<Bookmark>>(answer), *answer);
        let decoded: Vec<Bookmark> = serde_json::from_value(answer.clone()).unwrap();
        assert_eq!(decoded[0].last_recorded_at, Some(at(14)));
        // Never recorded is an explicit `null`, not an absent field.
        assert_eq!(answer[1]["lastRecordedAt"], Value::Null);
        assert_eq!(
            serde_json::to_value(&decoded[1]).unwrap()["lastRecordedAt"],
            Value::Null
        );
    }

    /// The page encodes each command's arguments to the same golden shapes.
    #[test]
    fn each_commands_arguments_match_the_golden_file() {
        let args = &golden()["commandArgs"];

        let add = &args["recorder_bookmark_add"];
        assert_eq!(round_trip::<BookmarkAddArgs>(add), *add);
        let rename = &args["recorder_bookmark_rename"];
        assert_eq!(round_trip::<BookmarkRenameArgs>(rename), *rename);
        for command in ["recorder_bookmark_remove", "recorder_bookmark_recorded"] {
            let url = &args[command];
            assert_eq!(round_trip::<BookmarkUrlArgs>(url), *url, "{command}");
        }
        // Every mutating command has its example, and no other key hides one.
        assert_eq!(args.as_object().unwrap().len(), 4);
    }

    #[test]
    fn the_file_holds_the_golden_shape() {
        let (data_root, bookmarks) = bookmarks();
        write_file(&data_root, r#"{"version": 1, "bookmarks": []}"#);
        bookmarks.add("LifeLabs reports", LIFELABS).unwrap();
        bookmarks.recorded(LIFELABS, at(14)).unwrap();
        bookmarks.add("Shoppers prescriptions", SHOPPERS).unwrap();

        let stored: Value = serde_json::from_str(&file_text(&data_root)).unwrap();

        assert_eq!(stored["version"], 1);
        assert_eq!(
            stored["bookmarks"],
            golden()["commands"]["recorder_bookmarks"]
        );
    }
}
