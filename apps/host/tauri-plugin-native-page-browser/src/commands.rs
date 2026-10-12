//! The IPC command. A thin wrapper: it builds the typed request and hands off to
//! the platform backend (`mobile::NativePageBrowser` on iOS/Android,
//! `desktop::NativePageBrowser` elsewhere) via the [`NativePageBrowserExt`]
//! accessor.

use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{BrowserEvent, OpenRequest};
use crate::{NativePageBrowserExt, Result};

/// JS entry point for [`crate::NativePageBrowserExt::native_page_browser`]'s
/// `open`. Invoked as `invoke('plugin:native-page-browser|open', { url, closed })`,
/// where `closed` is a `new Channel<BrowserEvent>()` the caller constructed to
/// hear the view close.
#[tauri::command]
pub(crate) async fn open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    closed: Channel<BrowserEvent>,
) -> Result<()> {
    app.native_page_browser()
        .open(OpenRequest { url, closed })
        .await
}
