//! The HAR Recorder's host-side logic: the bridge wire mirror and the
//! validated, atomic write into the app's `saved_data` directory.
//!
//! This crate deliberately has no `tauri` dependency — it compiles and
//! tests on a machine without a webview toolkit, and the Tauri glue
//! (listener, thread, emit) lives in `har-recorder-tauri-rust`. The split
//! keeps every decision that can be wrong — which names are safe, what the
//! wire looks like, what happens when the target exists — under a test
//! that runs everywhere.
//!
//! The archive itself is built on the web side (`har-recorder-core` →
//! `http-archive`) and rides the bridge as already-encoded text, so there
//! is one HAR emitter and no HAR model here.

pub mod bridge;
pub mod save;

pub use bridge::{
    HarRecorderHostToWeb, HarRecorderWebToHost, HAR_SAVED, HAR_SAVE_FAILED, SAVE_HAR, TAGS,
};
pub use save::{save_har, saved_data_dir, validate_file_name, SaveError, SAVED_DATA_DIR_NAME};
