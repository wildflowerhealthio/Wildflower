//! Tauri host glue for the HAR Recorder: one listener on the multiplexed
//! bridge channel, the write moved off the event thread, and the two terminal
//! answers. See the [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! Every decision lives in [`har_recorder_rust`], which needs no webview to be
//! tested; this module is only the glue.

use std::path::{Path, PathBuf};

use har_recorder_rust::bridge::{HarRecorderHostToWeb, HarRecorderWebToHost, SAVE_HAR, TAGS};
use har_recorder_rust::save::{save_har, saved_data_dir};
use shared_structures_rust::bridge::{BridgeEnvelope, BRIDGE_EVENT};
use tauri::{AppHandle, Emitter, Listener};
use tauri_plugin_log::log;

/// Wire the recorder's listener on the multiplexed bridge event.
///
/// `app_data_dir` is the directory the host already resolved and created in
/// `setup()`, passed in rather than resolved a second way; the `saved_data`
/// folder under it is named once, in
/// [`har_recorder_rust::save::saved_data_dir`].
///
/// Registers synchronously, so a `setup()` call cannot miss a message — the
/// webview's first `SaveHar` can only follow its own `__Ready`. Call once per
/// app lifecycle.
///
/// Sibling slices' tags are dropped silently; an undecodable payload is warned
/// and, when a file name can still be read out of it, answered with
/// `HarSaveFailed` so the page does not wait forever.
pub fn attach_har_recorder(app: &AppHandle, app_data_dir: PathBuf) {
    // The shared bridge channel has no automated cross-process tag guard, so
    // the boot log records who dispatches what. See the effect-messaging-tauri
    // README ("Tag uniqueness across processes").
    log::info!(
        "[har-recorder] listening on '{BRIDGE_EVENT}' for tags: {:?}",
        TAGS
    );
    // Resolved once, from the directory the host already created.
    let directory = saved_data_dir(&app_data_dir);
    let handle = app.clone();
    app.listen(BRIDGE_EVENT, move |event| {
        let payload = event.payload();
        let tag = match serde_json::from_str::<BridgeEnvelope>(payload) {
            Ok(envelope) => envelope.tag,
            Err(error) => {
                log::warn!("[har-recorder] undecodable bridge payload dropped: {error}");
                return;
            }
        };
        if tag == SAVE_HAR {
            handle_save_har(&handle, &directory, payload);
        }
    });
}

/// Decode a `SaveHar` and hand the write to a blocking worker.
///
/// The archive can be tens of megabytes and the listener runs on the event
/// thread every other bridge message shares, so nothing here touches the
/// filesystem. See [Review Standards][rs] rule 7.
///
/// [rs]: ../../../../docs/Agents/Review%20Standards%20Reference.md
fn handle_save_har(app: &AppHandle, directory: &Path, payload: &str) {
    let (file_name, text) = match serde_json::from_str::<HarRecorderWebToHost>(payload) {
        Ok(HarRecorderWebToHost::SaveHar { file_name, text }) => (file_name, text),
        Err(error) => {
            log::warn!("[har-recorder] undecodable {SAVE_HAR} payload: {error}");
            // The page waits on a terminal answer, so answer whenever the
            // envelope still names the recording. One too broken to name it is
            // dropped — there is nothing to address the failure to.
            match recover_file_name(payload) {
                Some(file_name) => emit(
                    app,
                    HarRecorderHostToWeb::HarSaveFailed {
                        file_name,
                        message: format!("the save request could not be read: {error}"),
                    },
                ),
                None => log::warn!(
                    "[har-recorder] dropping an undecodable {SAVE_HAR} with no readable fileName"
                ),
            }
            return;
        }
    };

    let handle = app.clone();
    let directory = directory.to_path_buf();
    // Detached on purpose: the answer is the emit inside.
    let _worker = tauri::async_runtime::spawn_blocking(move || {
        let answer = match save_har(&directory, &file_name, &text) {
            Ok(path) => {
                log::info!("[har-recorder] wrote {}", path.display());
                HarRecorderHostToWeb::HarSaved {
                    file_name,
                    path: path.to_string_lossy().into_owned(),
                }
            }
            Err(error) => {
                log::warn!("[har-recorder] failed to save {file_name}: {error}");
                HarRecorderHostToWeb::HarSaveFailed {
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

fn emit(app: &AppHandle, message: HarRecorderHostToWeb) {
    if let Err(error) = app.emit(BRIDGE_EVENT, &message) {
        log::error!("[har-recorder] failed to emit {message:?}: {error}");
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
        // `text` is a number, so `HarRecorderWebToHost` will not decode it.
        let payload = r#"{"_tag":"SaveHar","fileName":"a.har","text":7}"#;
        assert!(serde_json::from_str::<HarRecorderWebToHost>(payload).is_err());
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
