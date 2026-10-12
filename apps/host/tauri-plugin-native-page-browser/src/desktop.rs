//! Desktop backend. Opens the URL in the default browser through
//! `tauri-plugin-opener`'s Rust API. A browser tab isn't a window the app owns
//! or can see close, so the `closed` channel is dropped without an event.

use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::OpenRequest;

/// Build the desktop backend.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativePageBrowser<R>> {
    Ok(NativePageBrowser(PhantomData))
}

/// Desktop handle to the native-page-browser plugin. Holds nothing: the default
/// browser is the OS's, not the app's. The `R` parameter keeps the
/// [`NativePageBrowserExt`](crate::NativePageBrowserExt) signature the same on
/// every platform.
pub struct NativePageBrowser<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> NativePageBrowser<R> {
    /// Open `request.url` in the default browser. Never sends on
    /// `request.closed`.
    pub fn open(&self, request: OpenRequest) -> crate::Result<()> {
        let url = crate::url_scheme::parse_http_url(&request.url)?;
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
            .map_err(|error| crate::Error::Internal(error.to_string()))
    }
}
