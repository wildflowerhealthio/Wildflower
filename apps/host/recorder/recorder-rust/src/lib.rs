//! The Recorder's host-side logic: the save channel's wire mirror, the
//! validated, atomic write, where recordings are saved, and the bookmarks
//! kept in the data root. See the
//! [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! Deliberately no `tauri` dependency, so every decision that can be wrong
//! is testable on a machine without a webview toolkit; the Tauri glue lives
//! in `recorder-tauri`. The archive arrives as already-encoded
//! text — there is one HAR emitter, and it is on the web side.

pub mod bookmarks;
pub mod bridge;
pub mod recordings_folder;
pub mod save;

pub use bookmarks::{
    Bookmark, BookmarkAddArgs, BookmarkError, BookmarkRenameArgs, BookmarkUrlArgs, JsonBookmarks,
    BOOKMARKS_FILE_NAME, FIRST_RUN_BOOKMARKS,
};
pub use bridge::{
    RecorderHostToWeb, RecorderWebToHost, HAR_SAVED, HAR_SAVE_FAILED, SAVE_HAR, TAGS,
};
pub use recordings_folder::{Platform, RecordingsLocation, SaveFolder, RECORDINGS_DIR_NAME};
pub use save::{save_har, validate_file_name, SaveError};
