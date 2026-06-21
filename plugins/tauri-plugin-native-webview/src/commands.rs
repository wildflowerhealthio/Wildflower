//! The `open` IPC command. Thin wrapper: it builds an [`OpenRequest`] and hands
//! off to the platform backend (`mobile::NativeWebview` on iOS, the no-op
//! `desktop::NativeWebview` elsewhere) via the [`NativeWebviewExt`] accessor.

use tauri::{AppHandle, Runtime};

use crate::models::OpenRequest;
use crate::{NativeWebviewExt, Result};

/// Present the external `url` in a native webview popup.
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|open', { url })`. Resolves once the popup is
/// presented; rejects with [`crate::Error::UnsupportedPlatform`] on non-iOS.
#[tauri::command]
pub(crate) async fn open<R: Runtime>(app: AppHandle<R>, url: String) -> Result<()> {
    app.native_webview().open(OpenRequest { url })
}
