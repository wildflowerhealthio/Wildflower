//! Mobile backend. Registers the native plugin — Swift `NativeWebviewPlugin` on
//! iOS, Kotlin `NativeWebviewPlugin` on Android — and forwards each command to it
//! via `run_mobile_plugin`, **keyed by the caller-named instance `id`**. Both
//! targets present a native, JS-injectable web view (WKWebView /
//! `android.webkit.WebView`) with native chrome.
//!
//! ## Multi-instance parity with desktop
//!
//! Every method takes the same caller-named `id` the desktop backend uses, and
//! the native sides keep a **per-id instance registry** so distinct ids get
//! independent, concurrent instances (a background `sniffer` scrape and a
//! launched `launch` app coexist). Unlike desktop — which keys each method by a
//! separate `id` argument and never serialises it — mobile carries the id **in
//! the invoke payload** (via [`WithId`] / [`IdOnly`]); the native `@InvokeArg` /
//! `Decodable` sides read a top-level `id` and route to the matching instance.
//!
//! A phone shows one full-screen native webview at a time, so the native
//! `show(id)` performs a **foreground swap**: it hides whichever instance is
//! currently visible (keeping it alive) before presenting `id`. Non-visible
//! instances stay alive and running — a hidden `sniffer` keeps scraping while
//! `launch` is on screen. The cross-platform lifecycle/race protocols (dispose→open
//! race, per-instance idle-teardown backstop, channel rewire) apply **per id** on
//! mobile just as they do per id on desktop; see
//! [docs/Lifecycle and Races Explanation.md](../docs/Lifecycle%20and%20Races%20Explanation.md).

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{
    DisposeResponse, EvaluateJsRequest, EvaluateJsResponse, HideResponse, IdOnly, OpenRequest,
    OpenResponse, PatchWindowTextRequest, PatchWindowTextResponse, ShowResponse, WithId,
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

// Every method threads the caller-named instance `id` to the native side (wrapped
// in [`WithId`] / [`IdOnly`]), which keys its per-id instance registry by it —
// mirroring the desktop backend's per-id `PluginState`. Mobile presents one
// full-screen native webview at a time, so `show` performs a foreground swap (see
// the module doc and docs/Lifecycle and Races Explanation.md); non-visible
// instances stay alive. Multi-instance mobile support is tracked in
// https://github.com/wildflowerhealthio/Wildflower/issues/411.
impl<R: Runtime> NativeWebview<R> {
    /// Ensure instance `id`'s native webview exists (created hidden if absent) and
    /// navigate it to `payload.url` by invoking the Swift/Kotlin `openUrl` command.
    /// Does not change visibility — call [`show`](Self::show) to present.
    ///
    /// Validates the URL up front via [`crate::url_scheme::parse_http_url`] so
    /// every backend rejects a non-http(s) URL identically: the Android native
    /// side otherwise hands an unvalidated string straight to `WebView.loadUrl`
    /// and still resolves `opened: true`.
    pub fn open_url(&self, id: &str, payload: OpenRequest) -> crate::Result<()> {
        crate::url_scheme::parse_http_url(&payload.url)?;
        self.0
            .run_mobile_plugin::<OpenResponse>("openUrl", WithId { id, inner: payload })
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Present instance `id`'s native webview by invoking the Swift/Kotlin `show`
    /// command. A phone shows one native webview at a time, so this performs a
    /// **foreground swap** on the native side — hiding whichever instance was
    /// visible (kept alive) before presenting `id`. See
    /// [`ShowResponse`](crate::ShowResponse) for the idempotency contract.
    pub fn show(&self, id: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<ShowResponse>("show", IdOnly { id })
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Evaluate JS inside instance `id`'s native webview by invoking the
    /// Swift/Kotlin `evaluateJs` command. If that instance has no native webview
    /// open the native side rejects, surfaced here as
    /// [`Error::PluginInvoke`](crate::Error::PluginInvoke).
    pub fn evaluate_js(&self, id: &str, payload: EvaluateJsRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<EvaluateJsResponse>("evaluateJs", WithId { id, inner: payload })
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Patch instance `id`'s native chrome labels by invoking the Swift/Kotlin
    /// `patchWindowText` command. Best-effort: the native side resolves with
    /// `{set: false}` (not a hard reject) when that instance has no native webview
    /// open. See [`PatchWindowTextRequest`](crate::PatchWindowTextRequest).
    pub fn patch_window_text(
        &self,
        id: &str,
        payload: PatchWindowTextRequest,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<PatchWindowTextResponse>(
                "patchWindowText",
                WithId { id, inner: payload },
            )
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Hide instance `id`'s native webview by invoking the Swift/Kotlin `hide`
    /// command — removed from view but kept alive and running. Emits
    /// [`NativeWebviewEvent::Hidden`](crate::NativeWebviewEvent::Hidden) on that
    /// instance's channel once hidden. See [`HideResponse`](crate::HideResponse).
    pub fn hide(&self, id: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<HideResponse>("hide", IdOnly { id })
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }

    /// Dispose instance `id`'s native webview by invoking the Swift/Kotlin
    /// `dispose` command. Emits
    /// [`NativeWebviewEvent::Disposed`](crate::NativeWebviewEvent::Disposed) on
    /// that instance's channel once torn down. See
    /// [`DisposeResponse`](crate::DisposeResponse).
    pub fn dispose(&self, id: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<DisposeResponse>("dispose", IdOnly { id })
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }
}
