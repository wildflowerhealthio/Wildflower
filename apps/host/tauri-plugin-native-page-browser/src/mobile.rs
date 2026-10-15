//! Mobile backend. Registers the native plugin — Swift `NativePageBrowserPlugin`
//! on iOS, Kotlin `NativePageBrowserPlugin` on Android — and forwards `open` and
//! `close` to it via `run_mobile_plugin_async`.
//!
//! Async because the Swift side resolves only after a hop to the main queue: a
//! blocking `run_mobile_plugin` from the iOS main thread would never return,
//! and from an async command it would hold a tokio worker until it did.
//!
//! What an `open` does beside the views showing is its
//! [`OpenMode`](crate::OpenMode)'s. On iOS a `Replace` open dismisses the
//! showing views (sending `Closed` on each one's channel) before presenting
//! the new one, and a `Stack` open presents it over them; `close` dismisses
//! one view and those over it. On Android, where a Custom Tab can't be closed
//! programmatically, a `Replace` open joins a view still launching, a `Stack`
//! open launches its own, either returns an error while the app is in the
//! background, and `close` always returns one.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{CloseRequest, OpenRequest};

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
    /// `open` command, beside the views showing as `request.mode` says (see
    /// the module doc). The native side
    /// sends [`BrowserEvent::Closed`](crate::BrowserEvent::Closed) on
    /// `request.events` once the view is gone, and on Android
    /// [`BrowserEvent::KeptAlive`](crate::BrowserEvent::KeptAlive) before it
    /// when the view's browser keeps the app alive.
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

    /// Close the view opened under `request.view`, and on iOS any view over
    /// it, by invoking the Swift/Kotlin `close` command. Each sends its
    /// [`BrowserEvent::Closed`](crate::BrowserEvent::Closed) as it goes. A view
    /// already gone closes nothing; Android, which can't close a Custom Tab,
    /// always returns an error.
    pub async fn close(&self, request: CloseRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin_async::<()>("close", request)
            .await
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))
    }
}
