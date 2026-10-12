//! Tauri host glue for the Recorder: one listener on the multiplexed
//! bridge channel, the write moved off the event thread, and the two terminal
//! answers. See the
//! [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! Every decision lives in [`wildflowerhealthio_recorder`], which needs no webview to be
//! tested; this module is only the glue.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};
use tauri_plugin_log::log;
use wildflowerhealthio_recorder::bridge::{RecorderHostToWeb, RecorderWebToHost, SAVE_HAR, TAGS};
use wildflowerhealthio_recorder::recordings_folder::{Platform, RecordingsLocation};
use wildflowerhealthio_recorder::save::save_har;
use wildflowerhealthio_shared_structures::bridge::{BridgeEnvelope, BRIDGE_EVENT};

mod commands;

pub use commands::recorder_save_folder;

/// The recordings folder this run saves to, or why there is none, resolved
/// once by [`attach_recorder`]. `recorder_save_folder` reads it.
pub struct RecordingsFolder(Result<PathBuf, String>);

/// The directory Tauri resolves for `location`.
fn resolve_location<R: Runtime>(
    app: &AppHandle<R>,
    location: RecordingsLocation,
) -> tauri::Result<PathBuf> {
    match location {
        RecordingsLocation::UserDocuments
        | RecordingsLocation::AppExternalDocuments
        | RecordingsLocation::AppDocuments => app.path().document_dir(),
        RecordingsLocation::UserDownloads => app.path().download_dir().map(real_path),
        RecordingsLocation::SharedDocuments => app.path().home_dir(),
    }
}

/// `path` with its symlinks resolved, where they resolve.
///
/// Under the macOS App Sandbox, `download_dir` is the container's
/// `Data/Downloads`, a symlink to the user's `~/Downloads`; resolving it lets
/// the Recorder page show the folder the user finds in Finder. Only macOS
/// resolves it: on Windows a resolved path gains a `\\?\` prefix.
fn real_path(path: PathBuf) -> PathBuf {
    if cfg!(target_os = "macos") {
        std::fs::canonicalize(&path).unwrap_or(path)
    } else {
        path
    }
}

/// The recordings folder for [`Platform::current`]: its first location that
/// resolves and, where another location follows it, that the app can create.
///
/// Only the platform's own locations are resolved, and a last location isn't
/// created here: `save_har` creates it on the first save.
fn resolve_recordings_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let locations = Platform::current().recordings_locations();
    let mut reasons = Vec::new();
    for (index, location) in locations.iter().enumerate() {
        let directory = match resolve_location(app, *location) {
            Ok(resolved_dir) => location.recordings_dir(&resolved_dir),
            Err(error) => {
                reasons.push(format!("{location:?} could not be resolved: {error}"));
                continue;
            }
        };
        let has_fallback = index + 1 < locations.len();
        if !has_fallback {
            return Ok(directory);
        }
        // A later location is the fallback for one the app can't write to,
        // such as Android's shared Documents before Android 11 or a desktop
        // Documents folder the app can't create the folder in.
        match std::fs::create_dir_all(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) => {
                log::warn!(
                    "[recorder] can't save into {}, trying the next location: {error}",
                    directory.display()
                );
                reasons.push(format!(
                    "{} could not be created: {error}",
                    directory.display()
                ));
            }
        }
    }
    Err(format!("no recordings folder: {}", reasons.join("; ")))
}

/// Wire the recorder's listener on the multiplexed bridge event, and manage
/// the [`RecordingsFolder`] it saves into.
///
/// The recordings folder is resolved here, once, for
/// [`Platform::current`]. A platform where none resolves still attaches: each
/// `SaveHar` is answered with `HarSaveFailed` saying why.
///
/// Registers synchronously, so a `setup()` call cannot miss a message — the
/// webview's first `SaveHar` can only follow its own `__Ready`. Call once per
/// app lifecycle.
///
/// Sibling slices' tags are dropped silently; an undecodable payload is warned
/// and, when a file name can still be read out of it, answered with
/// `HarSaveFailed` so the page does not wait forever.
pub fn attach_recorder(app: &AppHandle) {
    // The shared bridge channel has no automated cross-process tag guard, so
    // the boot log records who dispatches what. See the effect-messaging-tauri-js
    // README ("Tag uniqueness across processes").
    log::info!("[recorder] listening on '{BRIDGE_EVENT}' for tags: {TAGS:?}");
    let directory = resolve_recordings_dir(app);
    match &directory {
        Ok(path) => log::info!("[recorder] recordings are saved to {}", path.display()),
        Err(reason) => log::error!("[recorder] recordings can't be saved: {reason}"),
    }
    app.manage(RecordingsFolder(directory.clone()));
    let handle = app.clone();
    app.listen(BRIDGE_EVENT, move |event| {
        let payload = event.payload();
        let tag = match serde_json::from_str::<BridgeEnvelope>(payload) {
            Ok(envelope) => envelope.tag,
            Err(error) => {
                log::warn!("[recorder] undecodable bridge payload dropped: {error}");
                return;
            }
        };
        if tag == SAVE_HAR {
            handle_save_har(&handle, &directory, payload);
        } else if TAGS.contains(&tag.as_str()) {
            log::warn!("[recorder] unexpected inbound tag: {tag}");
        }
    });
}

/// Decode a `SaveHar` and hand the write to a blocking worker.
///
/// The archive can be tens of megabytes and the listener runs on the event
/// thread every other bridge message shares, so nothing here touches the
/// filesystem. See [Review Standards][rs] rule 7.
///
/// [rs]: ../../../../../docs/Agents/Review%20Standards%20Reference.md
fn handle_save_har(app: &AppHandle, directory: &Result<PathBuf, String>, payload: &str) {
    let (file_name, text) = match serde_json::from_str::<RecorderWebToHost>(payload) {
        Ok(RecorderWebToHost::SaveHar { file_name, text }) => (file_name, text),
        Err(error) => {
            log::warn!("[recorder] undecodable {SAVE_HAR} payload: {error}");
            // The page waits on a terminal answer, so answer whenever the
            // envelope still names the recording. One too broken to name it is
            // dropped — there is nothing to address the failure to.
            match recover_file_name(payload) {
                Some(file_name) => emit(
                    app,
                    RecorderHostToWeb::HarSaveFailed {
                        file_name,
                        message: format!("the save request could not be read: {error}"),
                    },
                ),
                None => log::warn!(
                    "[recorder] dropping an undecodable {SAVE_HAR} with no readable fileName"
                ),
            }
            return;
        }
    };

    let directory = match directory {
        Ok(directory) => directory.clone(),
        Err(reason) => {
            emit(
                app,
                RecorderHostToWeb::HarSaveFailed {
                    file_name,
                    message: reason.clone(),
                },
            );
            return;
        }
    };
    let handle = app.clone();
    // Detached on purpose: the answer is the emit inside.
    let _worker = tauri::async_runtime::spawn_blocking(move || {
        let answer = match save_har(&directory, &file_name, &text) {
            Ok(path) => {
                log::info!("[recorder] wrote {}", path.display());
                RecorderHostToWeb::HarSaved {
                    file_name,
                    path: path.to_string_lossy().into_owned(),
                }
            }
            Err(error) => {
                log::warn!("[recorder] failed to save {file_name}: {error}");
                RecorderHostToWeb::HarSaveFailed {
                    file_name,
                    message: error.to_string(),
                }
            }
        };
        emit(&handle, answer);
    });
}

/// The `fileName` of a `SaveHar` whose full payload did not decode — the
/// envelope peek widened by one field, so a page that sent an unreadable
/// `text` is still told which recording failed.
fn recover_file_name(payload: &str) -> Option<String> {
    let decoded: serde_json::Value = serde_json::from_str(payload).ok()?;
    decoded.get("fileName")?.as_str().map(str::to_owned)
}

fn emit(app: &AppHandle, message: RecorderHostToWeb) {
    if let Err(error) = app.emit(BRIDGE_EVENT, &message) {
        log::error!("[recorder] failed to emit {message:?}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recovery is what turns a malformed request into an answer rather than
    /// a page that waits forever, so it must survive exactly the payloads that
    /// made the typed decode fail.
    #[test]
    fn a_file_name_is_recovered_from_a_payload_the_typed_decode_rejects() {
        // `text` is a number, so `RecorderWebToHost` will not decode it.
        let payload = r#"{"_tag":"SaveHar","fileName":"a.har","text":7}"#;
        assert!(serde_json::from_str::<RecorderWebToHost>(payload).is_err());
        assert_eq!(recover_file_name(payload), Some("a.har".to_owned()));
    }

    #[test]
    fn a_payload_with_no_readable_file_name_recovers_nothing() {
        assert_eq!(recover_file_name(r#"{"_tag":"SaveHar"}"#), None);
        assert_eq!(
            recover_file_name(r#"{"_tag":"SaveHar","fileName":12}"#),
            None
        );
        assert_eq!(recover_file_name("not json at all"), None);
    }
}
