//! Mobile backend. Registers the native plugin — Swift `NativeWebviewPlugin` on
//! iOS, Kotlin `NativeWebviewPlugin` on Android — and forwards `open_url` to it
//! via `run_mobile_plugin`. Both targets present a native, JS-injectable web view
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
    ///
    /// Validates the URL up front via [`crate::url_scheme::parse_http_url`] so
    /// every backend rejects a non-http(s) URL identically: the Android native
    /// side otherwise hands an unvalidated string straight to `WebView.loadUrl`
    /// and still resolves `opened: true`.
    pub fn open_url(&self, payload: OpenRequest) -> crate::Result<()> {
        crate::url_scheme::parse_http_url(&payload.url)?;
        self.0
            .run_mobile_plugin::<OpenResponse>("openUrl", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Present the native webview by invoking the Swift/Kotlin `show` command.
    /// See [`ShowResponse`](crate::ShowResponse) for the idempotency contract.
    pub fn show(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<ShowResponse>("show", ())
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Evaluate JS inside the currently-open native webview by invoking the
    /// Swift/Kotlin `evaluateJs` command. If no native webview is open the native
    /// side rejects, surfaced here as
    /// [`Error::PluginInvoke`](crate::Error::PluginInvoke).
    pub fn evaluate_js(&self, payload: EvaluateJsRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<EvaluateJsResponse>("evaluateJs", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Patch the native webview's chrome labels by invoking the Swift/Kotlin
    /// `patchWindowText` command. Best-effort: the native side resolves with
    /// `{set: false}` (not a hard reject) when no native webview is open. See
    /// [`PatchWindowTextRequest`](crate::PatchWindowTextRequest).
    pub fn patch_window_text(&self, payload: PatchWindowTextRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<PatchWindowTextResponse>("patchWindowText", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Hide the currently-presented native webview by invoking the Swift/Kotlin
    /// `hide` command. Emits [`NativeWebviewEvent::Hidden`](crate::NativeWebviewEvent::Hidden)
    /// on the open channel once hidden. See [`HideResponse`](crate::HideResponse).
    pub fn hide(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<HideResponse>("hide", ())
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Dispose the native webview by invoking the Swift/Kotlin `dispose` command.
    /// Emits [`NativeWebviewEvent::Disposed`](crate::NativeWebviewEvent::Disposed)
    /// on the open channel once torn down. See
    /// [`DisposeResponse`](crate::DisposeResponse).
    pub fn dispose(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<DisposeResponse>("dispose", ())
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }
}
