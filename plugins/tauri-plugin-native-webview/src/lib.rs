//! `tauri-plugin-native-webview` — present an external URL in a *native*,
//! JavaScript-injectable web view popup, with native chrome.
//!
//! Why this exists: the browser-sniffer slice currently opens external pages in
//! a Tauri `WebviewWindow` and draws fake browser chrome (`injectBrowserTopBar`)
//! in-page, while exposing `window.__TAURI__` to arbitrary third-party origins.
//! This plugin replaces that on iOS with a real `WKWebView` presented modally
//! with a native toolbar, injecting JS at document start on any origin via
//! `WKUserScript`, and bridging messages back through a scoped
//! `WKScriptMessageHandler` — no `__TAURI__` exposure.
//!
//! Status: **iOS only**, running in parallel with the existing
//! `WebviewWindow` path (desktop + Android are unchanged; `open` returns
//! [`Error::UnsupportedPlatform`] there). See `docs/Explanation.md`.
//!
//! Usage from the webview:
//! ```js
//! import { invoke } from '@tauri-apps/api/core'
//! import { addPluginListener } from '@tauri-apps/api/core'
//!
//! await addPluginListener('native-webview', 'message', (p) => console.log(p))
//! await invoke('plugin:native-webview|open', { url: 'https://example.test' })
//! ```

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::{OpenRequest, OpenResponse};

mod commands;
mod error;
mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop::NativeWebview;
#[cfg(mobile)]
use mobile::NativeWebview;

/// Accessor for the plugin's managed backend from any [`Manager`].
pub trait NativeWebviewExt<R: Runtime> {
    /// The platform backend (`mobile::NativeWebview` on iOS, the no-op
    /// `desktop::NativeWebview` elsewhere).
    fn native_webview(&self) -> &NativeWebview<R>;
}

impl<R: Runtime, T: Manager<R>> NativeWebviewExt<R> for T {
    fn native_webview(&self) -> &NativeWebview<R> {
        self.state::<NativeWebview<R>>().inner()
    }
}

/// Initialize the plugin. Register on the host with
/// `.plugin(tauri_plugin_native_webview::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-webview")
        .invoke_handler(tauri::generate_handler![commands::open])
        .setup(|app, api| {
            #[cfg(mobile)]
            let native = mobile::init(app, api)?;
            #[cfg(desktop)]
            let native = desktop::init(app, api)?;
            app.manage(native);
            Ok(())
        })
        .build()
}
