//! The Tauri host's [`apps_rust::LaunchSink`].
//!
//! The apps launch handler (`POST /apps/{id}`) resolves the launch URL and,
//! when a sink is installed, hands it here instead of returning a `302`. This
//! sink opens the resolved URL in a separate, less-privileged native webview
//! popup via [`tauri_plugin_native_webview`] — so the main SPA stays mounted
//! and the user dismisses the popup from the plugin's native chrome (Close /
//! Back / Forward). This replaces the former `RequestSandboxedWebView` bridge
//! round-trip: the server already owns origin/tunnel resolution, so the host
//! only needs the finished URL.

use apps_rust::domain::AppEntry;
use apps_rust::LaunchSink;
use tauri::AppHandle;
use tauri_plugin_log::log;

/// The host's launch sink: opens the resolved launch URL in a native webview
/// popup. Holds the [`AppHandle`] the popup is opened through.
pub struct TauriLaunchSink {
    app: AppHandle,
}

impl TauriLaunchSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl LaunchSink for TauriLaunchSink {
    /// Open `url` in the shared native webview popup, titled with the app's
    /// name. Fire-and-forget: the underlying `tauri-plugin-native-webview`
    /// `open_url` does `run_on_main_thread(...)` then blocks on `rx.recv()` until
    /// the main thread finishes building the popup — so the actual open is
    /// dispatched onto a blocking thread via `tauri::async_runtime::spawn_blocking`
    /// rather than held on the request worker. The launch handler has already
    /// `204`d by the time the popup is constructed, and a failure here is
    /// logged (the handler can't surface it anyway).
    fn open(&self, app: &AppEntry, url: &str) {
        // Clone everything the spawned closure needs — `AppHandle`, `AppEntry`,
        // `String` — so the blocking task owns its inputs and the caller's
        // worker isn't parked.
        let handle = self.app.clone();
        let app = app.clone();
        let url = url.to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = open_app_in_native_webview(&handle, &app, &url) {
                log::error!("[launch] failed to open native webview for launch: {error}");
            }
        });
    }
}

/// Present `url` in the shared native webview popup, titled with `app.name`.
///
/// Validates the URL is `http(s)://` (defense-in-depth — the server already
/// builds it from a trusted loopback/tunnel origin), then `open_url`s it and
/// `show`s the popup. The plugin's hide/dispose model keeps visibility
/// independent of content, so building/navigating (`open_url`) and presenting
/// (`show`) are two calls — mirroring the sniffer's present path. The apps
/// launch flow has no host↔popup bridge of its own (no sniffing, no host→web
/// reply), so it passes no `init_script` and a no-op event channel — the popup
/// is self-contained and the user closes it from the native chrome. Both calls
/// are idempotent: a second launch while a popup is up navigates the existing
/// content webview and re-shows it rather than stacking a new presentation.
fn open_app_in_native_webview(handle: &AppHandle, app: &AppEntry, url: &str) -> anyhow::Result<()> {
    use tauri::ipc::Channel;
    use tauri_plugin_native_webview::{NativeWebviewEvent, NativeWebviewExt, OpenRequest};

    // `resolve_http_url` enforces http(s)-only (rejecting `file:` / `javascript:`
    // and unparseable URLs). We only need it to gate the string; the plugin
    // re-parses it.
    shared_structures_tauri_rust::resolve_http_url(url)
        .map_err(|error| anyhow::anyhow!("launch URL rejected: {error}"))?;

    // No popup events to consume: native chrome owns the Close button and the
    // apps flow expects no host→web reply, so a no-op channel satisfies the
    // plugin's `open_url` contract without re-emitting anything onto a bridge.
    // Unlike the sniffer, the apps launch holds no long-lived channel — it never
    // reacts to `Hidden`/`Disposed`; the plugin's own teardown backstop reclaims
    // an idle-hidden popup.
    let channel: Channel<NativeWebviewEvent> = Channel::new(|_event| Ok(()));
    // `open_url` builds (if absent) and navigates the content webview without
    // presenting it; `show` reveals it. Two calls because the plugin's
    // hide/dispose model keeps visibility independent of content.
    handle
        .native_webview()
        .open_url(OpenRequest {
            url: url.to_owned(),
            init_script: None,
            native_webview_event_channel: channel,
            // Native chrome defaults its title to the URL host (e.g. a bare
            // `127.0.0.1`); show the launched app's own name instead.
            initial_title: Some(app.name.clone()),
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
