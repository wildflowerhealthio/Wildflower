//! The Recorder page's host command.

use tauri::State;
use wildflowerhealthio_recorder::recordings_folder::{Platform, SaveFolder};

use crate::RecordingsFolder;

/// The recordings folder, as the Recorder page shows it, or why there is
/// none.
///
/// Granted to the `main` webview through the app's `allow-recorder`
/// permission.
#[tauri::command]
pub fn recorder_save_folder(folder: State<'_, RecordingsFolder>) -> Result<SaveFolder, String> {
    folder
        .0
        .as_ref()
        .map_err(Clone::clone)
        .map(|path| SaveFolder {
            path: path.to_string_lossy().into_owned(),
            reveals_files: Platform::CURRENT.reveals_files(),
        })
}
