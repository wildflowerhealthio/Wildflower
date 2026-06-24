//! Mobile backend. Registers the native plugin — Swift `NativeWebviewPlugin` on
//! iOS, Kotlin `NativeWebviewPlugin` on Android — and forwards `open` to it via
//! `run_mobile_plugin`. Both targets present a native, JS-injectable web view
//! (WKWebView / `android.webkit.WebView`) with native chrome.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{
    CloseRequest, CloseResponse, OpenRequest, OpenResponse, SendRequest, SendResponse,
    SetChromeRequest, SetChromeResponse,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_webview);

/// Android plugin identifier — the Kotlin library's package
/// (`android/build.gradle.kts` `namespace`). Tauri resolves the `@TauriPlugin`
/// class within it.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.plugin.nativewebview";

/// Build the mobile backend, registering the native plugin for the target OS.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    #[cfg(target_os = "ios")]
    let handle = api
        .register_ios_plugin(init_plugin_native_webview)
        .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
    #[cfg(target_os = "android")]
    let handle = api
        .register_android_plugin(PLUGIN_IDENTIFIER, "NativeWebviewPlugin")
        .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;

    Ok(NativeWebview(handle))
}

/// Mobile handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(tauri::plugin::PluginHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Present the native popup by invoking the Swift/Kotlin `open` command.
    pub fn open(&self, payload: OpenRequest) -> crate::Result<()> {
        // Validate the URL up front (http(s)-only — see [`crate::url_scheme`])
        // so every backend rejects a bad or non-http(s) URL the same way — the
        // Android native side otherwise hands an unvalidated string straight to
        // `WebView.loadUrl` and still resolves `opened: true`.
        crate::url_scheme::parse_http_url(&payload.url)?;
        self.0
            .run_mobile_plugin::<OpenResponse>("open", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Evaluate JS inside the currently-open native popup by invoking the
    /// Swift/Kotlin `send` command. The native side rejects with a string
    /// error if no popup is open, surfaced here as
    /// [`Error::PluginInvoke`](crate::Error::PluginInvoke).
    pub fn send(&self, payload: SendRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SendResponse>("send", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Update one or more of the popup's three chrome labels (`title`,
    /// `subtitle`, `message`). The native side resolves with `{set: true}`
    /// once the labels are applied on the UI thread; resolves with
    /// `{set: false}` (not a hard reject) when no popup is open, which the
    /// host should treat as best-effort.
    pub fn set_chrome(&self, payload: SetChromeRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<SetChromeResponse>("setChrome", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Dismiss the currently-presented popup. Idempotent — the native side
    /// resolves with `{closed: false}` if no popup was open. The native
    /// `dismiss` callback fires after the animation and lands a
    /// `PopupEvent::Closed` on the open channel — unless `suppress_close_event`
    /// is `true`, which makes that one dismissal silent (the host already
    /// observed the terminal event that triggered the close).
    pub fn close(&self, suppress_close_event: bool) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<CloseResponse>(
                "close",
                CloseRequest {
                    suppress_close_event,
                },
            )
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }
}
