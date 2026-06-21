//! Desktop backend (trial).
//!
//! A *non-Tauri* native web view on desktop (raw `WKWebView` via objc2 /
//! `WebView2` via the windows crate) would require `unsafe` FFI, which this
//! workspace forbids (`unsafe_code = "forbid"`). So the desktop trial presents
//! Tauri's own webview — a real OS window with native chrome (`WebviewWindow`,
//! backed by WKWebView on macOS, WebView2 on Windows, webkit2gtk on Linux) — and
//! injects the document-start script via `initialization_script`.
//!
//! Caveat vs. mobile: a `WebviewWindow` is a Tauri webview, so `window.__TAURI__`
//! is present in the loaded page (scoped by `capabilities/native-webview-window.json`
//! to just the event bus, mirroring the browser-sniffer posture). The mobile
//! backends avoid that exposure entirely with a purpose-built message handler.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::models::OpenRequest;

/// Label for the desktop native-webview window. `capabilities/native-webview-window.json`
/// in the host app keys on this label to scope the (event-bus-only) grant.
const WINDOW_LABEL: &str = "native-webview";

/// Document-start script injected into the desktop popup. Mirrors the iOS/Android
/// trial scripts, but posts lifecycle pings over the Tauri event bus (the popup
/// is a Tauri webview), gated on `__TAURI__` so it no-ops if the global is absent.
const INJECTED_SCRIPT: &str = r#"
(function () {
  try {
    var tauri = window.__TAURI__;
    var canEmit = tauri && tauri.event && typeof tauri.event.emit === "function";
    var post = function (kind) {
      if (canEmit) {
        tauri.event.emit("native-webview:message", { kind: kind, url: location.href });
      }
    };
    post("injected");
    document.addEventListener("DOMContentLoaded", function () { post("domcontentloaded"); });
    window.addEventListener("load", function () { post("load"); });
  } catch (error) {
    // Never throw into the host page.
  }
})();
"#;

/// Build the desktop backend. Holds an `AppHandle` to build the popup window.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    Ok(NativeWebview(app.clone()))
}

/// Desktop handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Present the external `url` in a `WebviewWindow` popup. Window creation is
    /// marshalled onto the main thread (required on macOS). Trial-level: the
    /// dispatched build is best-effort — a structured error channel back to the
    /// caller can come with the full desktop pass; for now build failures are
    /// logged rather than surfaced through the `open` result.
    pub fn open(&self, payload: OpenRequest) -> crate::Result<()> {
        let app = self.0.clone();
        self.0
            .run_on_main_thread(move || {
                if let Err(error) = present(&app, &payload.url) {
                    eprintln!("native-webview: failed to open desktop popup: {error}");
                }
            })
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        Ok(())
    }
}

/// Open the popup window, or navigate it if it already exists.
fn present<R: Runtime>(app: &AppHandle<R>, url: &str) -> crate::Result<()> {
    let parsed =
        Url::parse(url).map_err(|error| crate::Error::Internal(format!("invalid URL {url}: {error}")))?;

    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        existing
            .navigate(parsed)
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(parsed))
        .initialization_script(INJECTED_SCRIPT)
        .title("Wildflower")
        .build()
        .map_err(|error| crate::Error::Internal(error.to_string()))?;
    Ok(())
}
