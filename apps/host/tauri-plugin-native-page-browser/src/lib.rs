//! `tauri-plugin-native-page-browser` — open an external URL in the system's
//! in-app browser, presented as a native page, and tell Rust when it closes.
//!
//! The base can't script the page: the in-app browser is the OS's own, so
//! credentials typed into a server's sign-in page never pass through the app
//! (RFC 8252). See `docs/Explanation.md` for why this is its own plugin.
//!
//! Backends:
//! - **iOS** — Swift `SFSafariViewController`, in the app's colours. A
//!   [`OpenMode::Replace`] `open` replaces the showing views, a
//!   [`OpenMode::Stack`] one presents over them, and `close` dismisses a view
//!   with the views over it.
//! - **Android** — Kotlin `androidx.browser` Custom Tab sliding in from the
//!   right, in the app's colours, which asks its browser to keep the app alive
//!   under it; the default browser when no Custom Tabs provider is installed.
//!   A [`OpenMode::Replace`] `open` joins a `Replace` view still launching, a
//!   [`OpenMode::Stack`] one launches its own, also over a view up over the
//!   app, and either returns an error while the app is in the background. A Custom Tab can't be closed, so
//!   `close` returns an error.
//! - **Desktop** — the default browser, through `tauri-plugin-opener`. A browser
//!   tab isn't a window the app owns, so desktop never reports a close, and
//!   `close` returns an error.
//!
//! On every platform a URL that doesn't parse or isn't `http(s)` returns
//! [`Error::InvalidUrl`] before any backend sees it. On iOS and Android the
//! `events` channel hears exactly one [`BrowserEvent::Closed`] per `open` that
//! returns `Ok`, and none after one that returns an `Err`. On Android it hears
//! [`BrowserEvent::KeptAlive`] before that when the view's browser keeps the
//! app alive under the view, and [`BrowserEvent::MovedToBackground`] and
//! [`BrowserEvent::ReturnedToForeground`] as the user leaves the app for the
//! home screen or another app with the view up, and comes back.
//!
//! Usage (Rust caller — the canonical path). `open` is async on every
//! platform; await it rather than blocking on it, since iOS answers from the
//! main thread:
//! ```ignore
//! use tauri::ipc::Channel;
//! use tauri_plugin_native_page_browser::{
//!     BrowserEvent, CloseRequest, NativePageBrowserExt, OpenMode, OpenRequest,
//! };
//!
//! let events: Channel<BrowserEvent> = Channel::new(move |body| {
//!     // body: tauri::ipc::InvokeResponseBody — deserialise as BrowserEvent.
//!     Ok(())
//! });
//! app.native_page_browser().open(OpenRequest {
//!     url: "https://example.test/".to_owned(),
//!     view: "page-1".to_owned(),
//!     mode: OpenMode::Stack,
//!     events,
//! })
//! .await?;
//! // iOS: dismiss it again.
//! app.native_page_browser().close(CloseRequest { view: "page-1".to_owned() }).await?;
//! ```
//!
//! JS callers can also drive the plugin through
//! `invoke('plugin:native-page-browser|open', { url, view, mode, events })`
//! with a `new Channel<BrowserEvent>()`, and
//! `invoke('plugin:native-page-browser|close', { view })`.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::{BrowserEvent, CloseRequest, OpenMode, OpenRequest};

mod commands;
mod error;
mod models;
mod url_scheme;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop::NativePageBrowser;
#[cfg(mobile)]
use mobile::NativePageBrowser;

/// Accessor for the plugin's managed backend from any [`Manager`].
pub trait NativePageBrowserExt<R: Runtime> {
    /// The platform backend (`mobile::NativePageBrowser` on iOS/Android,
    /// `desktop::NativePageBrowser` elsewhere).
    fn native_page_browser(&self) -> &NativePageBrowser<R>;
}

impl<R: Runtime, T: Manager<R>> NativePageBrowserExt<R> for T {
    fn native_page_browser(&self) -> &NativePageBrowser<R> {
        self.state::<NativePageBrowser<R>>().inner()
    }
}

/// Initialize the plugin. Register on the host with
/// `.plugin(tauri_plugin_native_page_browser::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-page-browser")
        .invoke_handler(tauri::generate_handler![commands::open, commands::close])
        .setup(|app, api| {
            #[cfg(mobile)]
            let browser = mobile::init(app, api)?;
            #[cfg(desktop)]
            let browser = desktop::init(app, api)?;
            app.manage(browser);
            Ok(())
        })
        .build()
}
