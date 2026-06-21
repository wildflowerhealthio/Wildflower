//! Mobile backend. Registers the native plugin — Swift `NativeWebviewPlugin` on
//! iOS, Kotlin `NativeWebviewPlugin` on Android — and forwards `open` to it via
//! `run_mobile_plugin`. Both targets present a native, JS-injectable web view
//! (WKWebView / `android.webkit.WebView`) with native chrome.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{OpenRequest, OpenResponse};

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
        self.0
            .run_mobile_plugin::<OpenResponse>("open", payload)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(())
    }
}
