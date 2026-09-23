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
//!
//! The popup starts with an empty cookie jar and nothing is seeded into it: a
//! launched app authenticates to the API with its own SMART bearer, or — for a
//! loopback app calling the loopback API — by the host's loopback-provenance
//! owner trust (`inject_loopback_owner_token`).

use apps_rust::OnDeviceWebviewHandle;
use tauri::AppHandle;
use tauri_plugin_log::log;

/// The `tauri-plugin-native-webview` instance id for an apps-launch popup. Each
/// launched app gets its **own** instance keyed `launch-<app-id>` — distinct from
/// the browser sniffer's scrape webview (`"sniffer"`) and from every other app,
/// so launching an app never navigates another app's (or a running scrape's)
/// webview, and each app keeps its own history/session and its own entry in the
/// mobile presentation stack. App ids are kebab slugs (`[a-z0-9-]`), so the
/// composed id stays a valid Tauri window label on desktop
/// (`native-webview-launch-<app-id>`).
fn launch_webview_id(app_id: &str) -> String {
    format!("launch-{app_id}")
}

/// The host's on-device webview handle: opens the resolved launch URL in a
/// native webview popup.
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
    fn open(&self, app_id: String, title: String, url: String) {
        let handle = self.app.clone();
        // Each app gets its own `launch-<app-id>` instance (see `launch_webview_id`).
        let id = launch_webview_id(&app_id);

        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = open_app_in_native_webview(&handle, &id, title, url) {
                log::error!("[launch] failed to open native webview for launch: {error}");
            }
        });
    }
}

/// Present `url` in the `id` native webview popup, titled with `title` (the
/// launched app's name).
///
/// Validates the URL is `http(s)://` (defense-in-depth — the server already
/// builds it from a trusted origin), then `open_url`s it and `show`s it (two
/// calls, per the plugin's visibility-independent-of-content model). The apps
/// launch has no host↔popup bridge, so it injects no `init_script` and passes a
/// no-op event channel. Both calls are idempotent per `id`: re-launching the
/// **same** app navigates its existing popup, while a different app opens its own
/// instance (presented on top of the stack on mobile).
fn open_app_in_native_webview(
    handle: &AppHandle,
    id: &str,
    title: String,
    url: String,
) -> anyhow::Result<()> {
    use tauri::ipc::Channel;
    use tauri_plugin_native_webview::{NativeWebviewEvent, NativeWebviewExt, OpenRequest};

    // `resolve_http_url` enforces http(s)-only (rejecting `file:` / `javascript:`
    // and unparseable URLs). We only need it to gate the string; the plugin
    // re-parses it.
    shared_structures_tauri_rust::resolve_http_url(&url)
        .map_err(|error| anyhow::anyhow!("launch URL rejected: {error}"))?;

    // No popup events to consume: native chrome owns Close and the apps flow
    // expects no host→web reply, so a no-op channel satisfies `open_url`.
    let channel: Channel<NativeWebviewEvent> = Channel::new(|_event| Ok(()));
    handle
        .native_webview()
        .open_url(
            id,
            OpenRequest {
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
                // Nothing is seeded: see the module doc.
                cookies: Vec::new(),
                // No download story for launched apps yet; the plugin's
                // default blocks them.
                download_dir: None,
            },
        )
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview open_url failed: {error}"))?;
    handle
        .native_webview()
        .show(id)
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview show failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each app gets its own popup instance, keyed off its id, so launching one
    /// app never navigates another's (or the sniffer's) webview.
    #[test]
    fn each_app_gets_its_own_launch_instance() {
        assert_eq!(launch_webview_id("web-trace-app"), "launch-web-trace-app");
        assert_ne!(launch_webview_id("a"), launch_webview_id("b"));
        assert_ne!(launch_webview_id("sniffer"), "sniffer");
    }
}
