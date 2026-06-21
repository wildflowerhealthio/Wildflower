//! Mobile backend. On iOS it registers the Swift `NativeWebviewPlugin` and
//! forwards `open` to it via `run_mobile_plugin`. On Android (also `mobile` but
//! not `target_os = "ios"`) no native plugin is registered — the host keeps the
//! existing Tauri `WebviewWindow` sniffer path — so `open` reports
//! `UnsupportedPlatform`. The `PhantomData` keeps the `R` parameter live on
//! non-iOS builds where no `PluginHandle` is stored.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{OpenRequest, OpenResponse};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_webview);

/// Build the mobile backend, registering the Swift plugin on iOS.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    #[cfg_attr(not(target_os = "ios"), allow(unused_variables))] api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    #[cfg(target_os = "ios")]
    {
        let handle = api
            .register_ios_plugin(init_plugin_native_webview)
            .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
        Ok(NativeWebview {
            handle,
        })
    }
    #[cfg(not(target_os = "ios"))]
    {
        Ok(NativeWebview {
            _marker: std::marker::PhantomData,
        })
    }
}

/// Mobile handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _marker: std::marker::PhantomData<R>,
}

impl<R: Runtime> NativeWebview<R> {
    /// Present the native popup. iOS hands off to the Swift plugin; other
    /// mobile targets report `UnsupportedPlatform`.
    pub fn open(&self, payload: OpenRequest) -> crate::Result<()> {
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin::<OpenResponse>("open", payload)
                .map_err(|error| crate::Error::PluginInvoke(error.to_string()))?;
            Ok(())
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = payload;
            Err(crate::Error::UnsupportedPlatform)
        }
    }
}
