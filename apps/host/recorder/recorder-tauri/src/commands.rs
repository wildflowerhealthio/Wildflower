//! The Recorder page's host commands: the recordings folder, and the
//! bookmarks it records from.
//!
//! Every command is granted to the `main` webview through the app's
//! `allow-recorder` permission. Each bookmark command answers with every
//! bookmark after it, or the [`BookmarkError`]'s message, and does its file
//! IO on a blocking worker, off the IPC thread ([Review Standards][rs]
//! rule 7). Their parameters are `recorder-rust`'s `Bookmark*Args` fields,
//! pinned by `recorder-wire-golden.json`'s `commandArgs`.
//!
//! [rs]: ../../../../../docs/Agents/Review%20Standards%20Reference.md

use std::sync::Arc;

use chrono::Utc;
use tauri::State;
use wildflowerhealthio_recorder::bookmarks::{Bookmark, BookmarkError, JsonBookmarks};
use wildflowerhealthio_recorder::recordings_folder::{Platform, SaveFolder};

use crate::RecordingsFolder;

/// The recordings folder, as the Recorder page shows it, or why there is
/// none.
#[tauri::command]
pub fn recorder_save_folder(folder: State<'_, RecordingsFolder>) -> Result<SaveFolder, String> {
    folder
        .0
        .as_ref()
        .map_err(Clone::clone)
        .map(|path| SaveFolder {
            path: path.to_string_lossy().into_owned(),
            reveals_files: Platform::current().reveals_files(),
        })
}

/// Every bookmark.
#[tauri::command]
pub async fn recorder_bookmarks(
    bookmarks: State<'_, Arc<JsonBookmarks>>,
) -> Result<Vec<Bookmark>, String> {
    off_the_ipc_thread(&bookmarks, |bookmarks| bookmarks.read_all()).await
}

/// Bookmark `url` as `name`.
#[tauri::command]
pub async fn recorder_bookmark_add(
    bookmarks: State<'_, Arc<JsonBookmarks>>,
    name: String,
    url: String,
) -> Result<Vec<Bookmark>, String> {
    off_the_ipc_thread(&bookmarks, move |bookmarks| bookmarks.add(&name, &url)).await
}

/// Call the bookmark at `url` `name`.
#[tauri::command]
pub async fn recorder_bookmark_rename(
    bookmarks: State<'_, Arc<JsonBookmarks>>,
    url: String,
    name: String,
) -> Result<Vec<Bookmark>, String> {
    off_the_ipc_thread(&bookmarks, move |bookmarks| bookmarks.rename(&url, &name)).await
}

/// Drop the bookmark at `url`.
#[tauri::command]
pub async fn recorder_bookmark_remove(
    bookmarks: State<'_, Arc<JsonBookmarks>>,
    url: String,
) -> Result<Vec<Bookmark>, String> {
    off_the_ipc_thread(&bookmarks, move |bookmarks| bookmarks.remove(&url)).await
}

/// Stamp the bookmark at exactly `url` as recorded now. The page calls it as
/// a recording starts; a URL that isn't bookmarked changes nothing.
#[tauri::command]
pub async fn recorder_bookmark_recorded(
    bookmarks: State<'_, Arc<JsonBookmarks>>,
    url: String,
) -> Result<Vec<Bookmark>, String> {
    let now = Utc::now();
    off_the_ipc_thread(&bookmarks, move |bookmarks| bookmarks.recorded(&url, now)).await
}

/// Run `access` on a blocking worker, and answer with its bookmarks or its
/// error's message.
async fn off_the_ipc_thread(
    bookmarks: &Arc<JsonBookmarks>,
    access: impl FnOnce(&JsonBookmarks) -> Result<Vec<Bookmark>, BookmarkError> + Send + 'static,
) -> Result<Vec<Bookmark>, String> {
    let bookmarks = Arc::clone(bookmarks);
    tauri::async_runtime::spawn_blocking(move || access(&bookmarks))
        .await
        .map_err(|error| format!("the bookmarks couldn't be reached: {error}"))?
        .map_err(|error| error.to_string())
}
