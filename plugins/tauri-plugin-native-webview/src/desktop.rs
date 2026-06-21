//! Desktop backend. The native popup is iOS-only for now, so desktop keeps the
//! multi-window Tauri `WebviewWindow` sniffer path and this backend's `open`
//! reports `UnsupportedPlatform`. Implementing it (rather than `#[cfg]`-gating
//! the whole command away) keeps the IPC surface identical across platforms, so
//! the webview can feature-detect at runtime instead of at build time.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::OpenRequest;

/// Build the desktop backend. Holds an `AppHandle` for parity with the mobile
/// backend (future desktop implementations may present a separate window).
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    Ok(NativeWebview(app.clone()))
}

/// Desktop handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Desktop has no native popup yet — callers fall back to the existing
    /// Tauri `WebviewWindow` path.
    pub fn open(&self, _payload: OpenRequest) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }
}
