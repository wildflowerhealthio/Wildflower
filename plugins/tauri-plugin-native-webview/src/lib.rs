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
//! Backends (all trial-level, running in parallel with the existing
//! browser-sniffer `WebviewWindow` path):
//! - **iOS** — Swift `WKWebView` in a `UINavigationController`, native chrome.
//! - **Android** — Kotlin `android.webkit.WebView` in a `Dialog` + `Toolbar`.
//! - **Desktop** — a Tauri `WebviewWindow` (a non-Tauri native webview would
//!   need forbidden `unsafe` FFI); injection via `initialization_script`. The
//!   page sees a `__TAURI__` scoped to the event bus, unlike the mobile
//!   backends. See `desktop.rs` and `docs/Explanation.md`.
//!
//! Usage (Rust caller — the canonical path; the popup bridge stays Rust-side):
//! ```ignore
//! use tauri::ipc::Channel;
//! use tauri_plugin_native_webview::{NativeWebviewExt, OpenRequest, PopupEvent, SendRequest};
//!
//! // Long-lived channel: clones share the same handler (Arc-backed).
//! let channel: Channel<PopupEvent> = Channel::new(move |body| {
//!     // body: tauri::ipc::InvokeResponseBody — deserialise as PopupEvent and dispatch.
//!     Ok(())
//! });
//! app.native_webview().open(OpenRequest {
//!     url: "https://example.test/".to_owned(),
//!     init_script: Some("/* document-start IIFE */".to_owned()),
//!     channel: channel.clone(),
//! })?;
//! // Push a message into the popup later:
//! app.native_webview().send(SendRequest {
//!     script: "window.__nativeWebviewReceive('{\"event\":\"bridge\",\"payload\":…}')".to_owned(),
//! })?;
//! ```
//!
//! JS callers can also drive the plugin through `invoke('plugin:native-webview|open', { url, channel })`
//! with a `new Channel<PopupEvent>()`, but the design point is to keep popup
//! event bridging in Rust — see [`docs/Explanation.md`](../docs/Explanation.md).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::{
    CloseRequest, CloseResponse, OpenRequest, OpenResponse, PopupEvent, SendRequest, SendResponse,
    SetChromeRequest, SetChromeResponse,
};

mod commands;
mod error;
mod models;
mod url_scheme;

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
        .invoke_handler(tauri::generate_handler![
            commands::open,
            commands::send,
            commands::set_chrome,
            commands::close
        ])
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
