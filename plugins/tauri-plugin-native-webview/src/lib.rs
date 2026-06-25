//! `tauri-plugin-native-webview` — present an external URL in a *native*,
//! JavaScript-injectable web view, with native chrome.
//!
//! Security note: unlike the browser-sniffer `WebviewWindow` path it replaces,
//! the mobile backends draw native chrome and inject JS at document start on any
//! origin **without** exposing `window.__TAURI__` to third-party pages. See
//! `docs/Explanation.md` for the full rationale.
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
//! Usage (Rust caller — the canonical path; the native webview bridge stays Rust-side):
//! ```ignore
//! use tauri::ipc::Channel;
//! use tauri_plugin_native_webview::{EvaluateJsRequest, NativeWebviewEvent, NativeWebviewExt, OpenRequest};
//!
//! // Long-lived channel: clones share the same handler (Arc-backed).
//! let native_webview_event_channel: Channel<NativeWebviewEvent> = Channel::new(move |body| {
//!     // body: tauri::ipc::InvokeResponseBody — deserialise as NativeWebviewEvent and dispatch.
//!     Ok(())
//! });
//! app.native_webview().open_url(OpenRequest {
//!     url: "https://example.test/".to_owned(),
//!     init_script: Some("/* document-start IIFE */".to_owned()),
//!     native_webview_event_channel: native_webview_event_channel.clone(),
//!     initial_title: None,
//!     initial_subtitle: None,
//!     initial_message: None,
//! })?;
//! // `open_url` navigates without presenting; reveal it with `show()`.
//! app.native_webview().show()?;
//! // Push a message into the native webview later:
//! app.native_webview().evaluate_js(EvaluateJsRequest {
//!     script: "window.__nativeWebviewReceive('{\"event\":\"bridge\",\"payload\":…}')".to_owned(),
//! })?;
//! ```
//!
//! JS callers can also drive the plugin through `invoke('plugin:native-webview|open_url', { url, nativeWebviewEventChannel })`
//! with a `new Channel<NativeWebviewEvent>()`, but the design point is to keep
//! native webview event bridging in Rust — see [`docs/Explanation.md`](../docs/Explanation.md).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::{
    DisposeResponse, EvaluateJsRequest, EvaluateJsResponse, HideResponse, NativeWebviewEvent,
    OpenRequest, OpenResponse, PatchWindowTextRequest, PatchWindowTextResponse, ShowResponse,
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
    /// The platform backend (`mobile::NativeWebview` on iOS/Android,
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
            commands::open_url,
            commands::evaluate_js,
            commands::patch_window_text,
            commands::show,
            commands::hide,
            commands::dispose
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
