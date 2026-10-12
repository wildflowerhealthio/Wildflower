//! The Recorder's host-side logic: the save channel's wire mirror and the
//! validated, atomic write into the app's `saved_data` directory. See the
//! [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! Deliberately no `tauri` dependency, so every decision that can be wrong
//! is testable on a machine without a webview toolkit; the Tauri glue lives
//! in `recorder-tauri`. The archive arrives as already-encoded
//! text — there is one HAR emitter, and it is on the web side.

pub mod bridge;
pub mod save;

pub use bridge::{
    RecorderHostToWeb, RecorderWebToHost, HAR_SAVED, HAR_SAVE_FAILED, SAVE_HAR, TAGS,
};
pub use save::{save_har, saved_data_dir, validate_file_name, SaveError, SAVED_DATA_DIR_NAME};
