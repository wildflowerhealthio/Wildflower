//! [`TauriSnifferWebviewHandle`] — the Tauri implementation of
//! `browser-sniffer-rust`'s `SnifferWebviewHandle` port, over
//! `tauri-plugin-native-webview`. Mirrors the apps slice's
//! `NativeWebviewHandle` adapter shape (an `AppHandle`-holding struct the host
//! constructs in `setup()` and hands to the slice's `setup_*`).

use browser_sniffer_rust::SnifferWebviewHandle;
use tauri::AppHandle;
use tauri_plugin_native_webview::NativeWebviewExt;

use crate::native_webview_bridge::forward_to_native_webview;
use crate::sniffer_window;

/// The Tauri host's sniffer-webview port implementation.
pub struct TauriSnifferWebviewHandle {
    app: AppHandle,
}

impl TauriSnifferWebviewHandle {
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        TauriSnifferWebviewHandle { app }
    }
}

impl SnifferWebviewHandle for TauriSnifferWebviewHandle {
    fn open_or_navigate(&self, url: &str) -> anyhow::Result<()> {
        // Re-parse as defense-in-depth; the HTTP layer already validated the
        // source down to an `http(s)://` URL string.
        let parsed = url::Url::parse(url).map_err(|error| {
            anyhow::anyhow!("validated sniffer URL failed to re-parse: {error}")
        })?;
        sniffer_window::open_or_navigate(&self.app, parsed)
    }

    fn set_status(&self, name: &str) -> anyhow::Result<()> {
        sniffer_window::set_status(&self.app, name.to_owned())
    }

    fn show(&self) -> anyhow::Result<()> {
        self.app
            .native_webview()
            .show(crate::SNIFFER_WEBVIEW_ID)
            .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview show failed: {error}"))
    }

    fn dispose(&self) -> anyhow::Result<()> {
        self.app
            .native_webview()
            .dispose(crate::SNIFFER_WEBVIEW_ID)
            .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview dispose failed: {error}"))
    }

    fn forward_to_page(&self, envelope_json: &str) -> anyhow::Result<()> {
        forward_to_native_webview(&self.app, envelope_json)
    }
}
