//! `tauri-plugin-native-page-browser` — open an external URL in the system's
//! in-app browser, presented as a native page, and tell Rust when it closes.
//!
//! The base can't script the page: the in-app browser is the OS's own, so
//! credentials typed into a server's sign-in page never pass through the app
//! (RFC 8252). See `docs/Explanation.md` for why this is its own plugin.
//!
//! Backends:
//! - **iOS** — Swift `SFSafariViewController`, in the app's colours. An `open`
//!   replaces a showing view.
//! - **Android** — Kotlin `androidx.browser` Custom Tab sliding in from the
//!   right, in the app's colours; the default browser when no Custom Tabs
//!   provider is installed. An `open` returns an error while a view is showing
//!   or the app is in the background.
//! - **Desktop** — the default browser, through `tauri-plugin-opener`. A browser
//!   tab isn't a window the app owns, so desktop never reports a close.
//!
//! Usage (Rust caller — the canonical path). `open` is async on every
//! platform; await it rather than blocking on it, since iOS answers from the
//! main thread:
//! ```ignore
//! use tauri::ipc::Channel;
//! use tauri_plugin_native_page_browser::{BrowserEvent, NativePageBrowserExt, OpenRequest};
//!
//! let closed: Channel<BrowserEvent> = Channel::new(move |body| {
//!     // body: tauri::ipc::InvokeResponseBody — deserialise as BrowserEvent.
//!     Ok(())
//! });
//! app.native_page_browser().open(OpenRequest {
//!     url: "https://example.test/".to_owned(),
//!     closed,
//! })
//! .await?;
//! ```
//!
//! JS callers can also drive the plugin through
//! `invoke('plugin:native-page-browser|open', { url, closed })` with a
//! `new Channel<BrowserEvent>()`.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::{BrowserEvent, OpenRequest};

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
        .invoke_handler(tauri::generate_handler![commands::open])
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
