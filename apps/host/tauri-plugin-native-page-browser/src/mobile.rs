//! Mobile backend. Registers the native plugin — Swift `NativePageBrowserPlugin`
//! on iOS, Kotlin `NativePageBrowserPlugin` on Android — and forwards `open` to
//! it via `run_mobile_plugin_async`.
//!
//! Async because the Swift side resolves only after a hop to the main queue: a
//! blocking `run_mobile_plugin` from the iOS main thread would never return,
//! and from an async command it would hold a tokio worker until it did.
//!
//! A phone shows one in-app browser view at a time. On iOS the native `open`
//! dismisses a showing view (sending `Closed` on that view's channel) before
//! presenting the new one. On Android, where a Custom Tab can't be closed
//! programmatically, it returns an error while a view is showing or while the
//! app is in the background.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::OpenRequest;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_page_browser);

/// Android plugin identifier — the Kotlin library's package
/// (`android/build.gradle.kts` `namespace`). Tauri resolves the `@TauriPlugin`
/// class within it.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.wildflowerhealth.nativepagebrowser";

/// Build the mobile backend, registering the native plugin for the target OS.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NativePageBrowser<R>> {
    #[cfg(target_os = "ios")]
    let handle = api
        .register_ios_plugin(init_plugin_native_page_browser)
        .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
    #[cfg(target_os = "android")]
    let handle = api
        .register_android_plugin(PLUGIN_IDENTIFIER, "NativePageBrowserPlugin")
        .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;

    Ok(NativePageBrowser(handle))
}

/// Mobile handle to the native-page-browser plugin.
pub struct NativePageBrowser<R: Runtime>(tauri::plugin::PluginHandle<R>);

impl<R: Runtime> NativePageBrowser<R> {
    /// Present `request.url` in the in-app browser by invoking the Swift/Kotlin
    /// `open` command. iOS replaces a view already showing; Android returns an
    /// error instead (see the module doc). The native side sends
    /// [`BrowserEvent::Closed`](crate::BrowserEvent::Closed) on
    /// `request.closed` once the view is gone.
    ///
    /// Validates the URL up front via [`crate::url_scheme::parse_http_url`] and
    /// sends its normalised form, so the native side parses exactly the
    /// `http(s)` URL Rust accepted (not, say, the caller's leading space).
    pub async fn open(&self, request: OpenRequest) -> crate::Result<()> {
        let url = crate::url_scheme::parse_http_url(&request.url)?;
        self.0
            .run_mobile_plugin_async::<()>(
                "open",
                OpenRequest {
                    url: url.into(),
                    ..request
                },
            )
            .await
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))
    }
}
