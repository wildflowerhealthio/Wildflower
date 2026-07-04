//! The Tauri host's [`apps_rust::OnDeviceWebviewHandle`].
//!
//! The apps launch handler (`POST /apps/{id}`) resolves the launch URL and, for
//! a loopback (local) caller, hands it here instead of returning a `302`. This
//! handle opens the resolved URL in a separate, less-privileged native webview
//! popup via [`tauri_plugin_native_webview`] — so the main SPA stays mounted
//! and the user dismisses the popup from the plugin's native chrome (Close /
//! Back / Forward). This replaces the former `RequestSandboxedWebView` bridge
//! round-trip: the server already owns origin/tunnel resolution, so the host
//! only needs the finished URL.

use apps_rust::OnDeviceWebviewHandle;
use tauri::AppHandle;
use tauri_plugin_log::log;

/// The host's on-device webview handle: opens the resolved launch URL in a
/// native webview popup. Holds the [`AppHandle`] the popup is opened through.
pub struct NativeWebviewHandle {
    app: AppHandle,
}

impl NativeWebviewHandle {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl OnDeviceWebviewHandle for NativeWebviewHandle {
    /// Open `url` in the shared native webview popup, titled with the app's
    /// name. Fire-and-forget: the underlying `tauri-plugin-native-webview`
    /// `open_url` does `run_on_main_thread(...)` then blocks on `rx.recv()` until
    /// the main thread finishes building the popup — so the actual open is
    /// dispatched onto a blocking thread via `tauri::async_runtime::spawn_blocking`
    /// rather than held on the request worker. The launch handler has already
    /// `204`d by the time the popup is constructed, and a failure here is
    /// logged (the handler can't surface it anyway).
    ///
    /// The handler only calls this for a loopback (local) caller — a host popup
    /// is useless to a remote one — so this impl doesn't re-check provenance.
    fn open(&self, title: String, url: String) {
        let handle = self.app.clone();

        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = open_app_in_native_webview(&handle, title, url) {
                log::error!("[launch] failed to open native webview for launch: {error}");
            }
        });
    }
}

/// Present `url` in the shared native webview popup, titled with `title` (the
/// launched app's name).
///
/// Validates the URL is `http(s)://` (defense-in-depth — the server already
/// builds it from a trusted loopback/tunnel origin), then `open_url`s it and
/// `show`s the popup. The plugin's hide/dispose model keeps visibility
/// independent of content, so building/navigating (`open_url`) and presenting
/// (`show`) are two calls — mirroring the sniffer's present path. The apps
/// launch flow has no host↔popup bridge of its own (no sniffing, no host→web
/// reply), so it injects no `init_script` and passes a no-op event channel — the
/// popup is self-contained and the user closes it from the native chrome. Both calls
/// are idempotent: a second launch while a popup is up navigates the existing
/// content webview and re-shows it rather than stacking a new presentation.
fn open_app_in_native_webview(handle: &AppHandle, title: String, url: String) -> anyhow::Result<()> {
    use tauri::ipc::Channel;
    use tauri_plugin_native_webview::{NativeWebviewEvent, NativeWebviewExt, OpenRequest};

    // `resolve_http_url` enforces http(s)-only (rejecting `file:` / `javascript:`
    // and unparseable URLs). We only need it to gate the string; the plugin
    // re-parses it.
    shared_structures_tauri_rust::resolve_http_url(&url)
        .map_err(|error| anyhow::anyhow!("launch URL rejected: {error}"))?;

    // No popup events to consume: native chrome owns the Close button and the
    // apps flow expects no host→web reply, so a no-op channel satisfies the
    // plugin's `open_url` contract without re-emitting anything onto a bridge.
    // Unlike the sniffer, the apps launch holds no long-lived channel — it never
    // reacts to `Hidden`/`Disposed`; the plugin's own teardown backstop reclaims
    // an idle-hidden popup.
    let channel: Channel<NativeWebviewEvent> = Channel::new(|_event| Ok(()));
    handle
        .native_webview()
        .open_url(OpenRequest {
            url: url.to_owned(),
            // No host↔popup bridge on the apps-launch path, so no document-start
            // script is injected.
            init_script: None,
            native_webview_event_channel: channel,
            // Native chrome defaults its title to the URL host (e.g. a bare
            // `127.0.0.1`); show the launched app's own name instead.
            initial_title: Some(title),
            initial_subtitle: None,
            initial_message: None,
        })
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview open_url failed: {error}"))?;
    handle
        .native_webview()
        .show()
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview show failed: {error}"))?;
    Ok(())
}
