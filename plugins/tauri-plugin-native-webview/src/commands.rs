//! The `open` IPC command. Thin wrapper: it builds an [`OpenRequest`] and hands
//! off to the platform backend (`mobile::NativeWebview` on iOS/Android, the
//! `desktop::NativeWebview` `WebviewWindow` backend elsewhere) via the
//! [`NativeWebviewExt`] accessor.

use tauri::{AppHandle, Runtime};

use crate::models::OpenRequest;
use crate::{NativeWebviewExt, Result};

/// Present the external `url` in a native webview popup, injecting `initScript`
/// at document start on any origin (if provided).
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|open', { url, initScript })`. Tauri maps the
/// camelCase `initScript` arg to the snake_case `init_script` parameter.
#[tauri::command]
pub(crate) async fn open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    init_script: Option<String>,
) -> Result<()> {
    app.native_webview().open(OpenRequest { url, init_script })
}
