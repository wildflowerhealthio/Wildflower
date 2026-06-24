//! Mobile backend. Registers the native plugin — Swift `NativeWebviewPlugin` on
//! iOS, Kotlin `NativeWebviewPlugin` on Android — and forwards `open` to it via
//! `run_mobile_plugin`. Both targets present a native, JS-injectable web view
//! (WKWebView / `android.webkit.WebView`) with native chrome.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{
    DisposeResponse, EvaluateJsRequest, EvaluateJsResponse, HideResponse, OpenRequest,
    OpenResponse, PatchWindowTextRequest, PatchWindowTextResponse, ShowResponse,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_webview);

/// Android plugin identifier — the Kotlin library's package
/// (`android/build.gradle.kts` `namespace`). Tauri resolves the `@TauriPlugin`
/// class within it.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.wildflowerhealth.nativewebview";

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
    /// Ensure a native webview exists (created hidden if absent) and navigate it
    /// to `payload.url` by invoking the Swift/Kotlin `openUrl` command. Does not
    /// change visibility — call [`show`](Self::show) to present.
    pub fn open_url(&self, payload: OpenRequest) -> crate::Result<()> {
        // Validate the URL up front (http(s)-only — see [`crate::url_scheme`])
        // so every backend rejects a bad or non-http(s) URL the same way — the
        // Android native side otherwise hands an unvalidated string straight to
        // `WebView.loadUrl` and still resolves `opened: true`.
        crate::url_scheme::parse_http_url(&payload.url)?;
        self.0
            .run_mobile_plugin::<OpenResponse>("openUrl", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Present the native webview — bring a freshly-created or previously-hidden
    /// instance to the foreground by invoking the Swift/Kotlin `show` command.
    /// Idempotent — the native side resolves with `{shown: false}` if none
    /// exists.
    pub fn show(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<ShowResponse>("show", ())
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Evaluate JS inside the currently-open native webview by invoking the
    /// Swift/Kotlin `evaluateJs` command. The native side rejects with a string
    /// error if no native webview is open, surfaced here as
    /// [`Error::PluginInvoke`](crate::Error::PluginInvoke).
    pub fn evaluate_js(&self, payload: EvaluateJsRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<EvaluateJsResponse>("evaluateJs", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Patch one or more of the native webview's three labels (`title`,
    /// `subtitle`, `message`). The native side resolves with `{set: true}`
    /// once the labels are applied on the UI thread; resolves with
    /// `{set: false}` (not a hard reject) when no native webview is open, which the
    /// host should treat as best-effort.
    pub fn patch_window_text(&self, payload: PatchWindowTextRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<PatchWindowTextResponse>("patchWindowText", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Hide the currently-presented native webview — remove it from view but
    /// keep it alive and running. Idempotent — the native side resolves with
    /// `{hidden: false}` if none was visible. The native side emits
    /// `NativeWebviewEvent::Hidden` on the open channel once hidden.
    pub fn hide(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<HideResponse>("hide", ())
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Dispose the native webview — tear it down (visible or hidden) and free
    /// its resources. Idempotent — the native side resolves with
    /// `{disposed: false}` if none existed. The native side emits
    /// `NativeWebviewEvent::Disposed` on the open channel once torn down.
    pub fn dispose(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<DisposeResponse>("dispose", ())
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }
}
