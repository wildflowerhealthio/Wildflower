//! The IPC commands. Thin wrappers: each builds the typed request and hands off
//! to the platform backend (`mobile::NativePageBrowser` on iOS/Android,
//! `desktop::NativePageBrowser` elsewhere) via the [`NativePageBrowserExt`]
//! accessor.

use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{BrowserEvent, CloseRequest, OpenMode, OpenRequest};
use crate::{NativePageBrowserExt, Result};

/// JS entry point for [`crate::NativePageBrowserExt::native_page_browser`]'s
/// `open`. Invoked as
/// `invoke('plugin:native-page-browser|open', { url, view, mode, events })`,
/// where `events` is a `new Channel<BrowserEvent>()` the caller constructed to
/// hear the view's events.
#[tauri::command]
pub(crate) async fn open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    view: String,
    mode: OpenMode,
    events: Channel<BrowserEvent>,
) -> Result<()> {
    app.native_page_browser()
        .open(OpenRequest {
            url,
            view,
            mode,
            events,
        })
        .await
}

/// JS entry point for [`crate::NativePageBrowserExt::native_page_browser`]'s
/// `close`. Invoked as `invoke('plugin:native-page-browser|close', { view })`.
#[tauri::command]
pub(crate) async fn close<R: Runtime>(app: AppHandle<R>, view: String) -> Result<()> {
    app.native_page_browser().close(CloseRequest { view }).await
}
