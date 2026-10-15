//! Desktop backend. Opens the URL in the default browser through
//! `tauri-plugin-opener`'s Rust API. A browser tab isn't a window the app owns,
//! can see close or can close, so the `events` channel is dropped without an
//! event, the open mode makes no difference, and `close` fails.

use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{CloseRequest, OpenRequest};

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
    /// Open `request.url` in the default browser, a new tab whatever
    /// `request.mode` says. Never sends on `request.events`. Async only to
    /// match the mobile backend's `open`.
    pub async fn open(&self, request: OpenRequest) -> crate::Result<()> {
        let url = crate::url_scheme::parse_http_url(&request.url)?;
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
            .map_err(|error| crate::Error::OpenDefaultBrowser(error.to_string()))
    }

    /// Fail with [`crate::Error::CloseDefaultBrowserTab`]: the tab `open`
    /// opened is the default browser's, not the app's. Async only to match
    /// the mobile backend's `close`.
    pub async fn close(&self, _request: CloseRequest) -> crate::Result<()> {
        Err(crate::Error::CloseDefaultBrowserTab)
    }
}

#[cfg(test)]
mod tests {
    use tauri::ipc::Channel;

    use super::*;
    use crate::models::OpenMode;

    /// A non-`http(s)` URL is refused before the opener is asked, so nothing
    /// launches.
    #[test]
    fn open_rejects_a_non_http_url_without_opening_it() {
        let browser = NativePageBrowser::<tauri::Wry>(PhantomData);
        let result = tauri::async_runtime::block_on(browser.open(OpenRequest {
            url: "javascript:alert(1)".to_owned(),
            view: "launch-1".to_owned(),
            mode: OpenMode::Replace,
            events: Channel::new(|_| Ok(())),
        }));
        assert!(
            matches!(result, Err(crate::Error::InvalidUrl(_))),
            "expected InvalidUrl, got {result:?}",
        );
    }
}
