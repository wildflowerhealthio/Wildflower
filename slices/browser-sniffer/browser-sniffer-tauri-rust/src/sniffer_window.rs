use tauri::{AppHandle, Manager, WebviewUrl};
use tauri_plugin_log::log;

#[cfg(any(target_os = "ios", target_os = "android"))]
use crate::bootstrap::NATIVE_SNIFFER_BOOTSTRAP;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::bootstrap::SNIFFER_BOOTSTRAP;

/// Present the sniffer's native webview via `tauri-plugin-native-webview` on
/// every target. The plugin owns the native webview's chrome (native toolbar on
/// iOS / Android, a multi-webview chrome bar on desktop), so the same call site
/// works across platforms — only the document-start `installSniffer` bootstrap
/// differs: mobile content webviews use the native-bridge variant
/// (`webkit.messageHandlers.nativeWebview` / `window.nativeWebview`),
/// desktop content webviews use the Tauri event-bus variant
/// (`__TAURI__.event`).
///
/// Page-initiated downloads are enabled for the sniffer instance and land in
/// [`sniffer_download_dir`] — desktop only; the plugin blocks them on any
/// instance that names no directory.
///
/// The plugin's `open` is idempotent: a second call while a native webview is up
/// navigates the existing content webview to `url` rather than stacking a new
/// presentation. The subtitle goes through the `open` request's
/// `initial_subtitle` rather than a post-open `patch_window_text` so it paints
/// with the native webview — on desktop `patch_window_text` would race the
/// not-yet-built chrome webview.
pub(crate) fn open_or_navigate(app: &AppHandle, url: WebviewUrl) -> anyhow::Result<()> {
    use tauri_plugin_native_webview::{NativeWebviewExt, OpenRequest};

    use crate::native_webview_bridge::NativeWebviewChannel;

    let WebviewUrl::External(parsed) = url else {
        anyhow::bail!(
            "non-External WebviewUrl handed to the native-webview path — only Uri sources are \
             supported today"
        )
    };

    // Per-target `installSniffer` IIFE; see `crate::bootstrap` for the variants.
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let bootstrap = NATIVE_SNIFFER_BOOTSTRAP;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let bootstrap = SNIFFER_BOOTSTRAP;

    // Reuse the long-lived channel across opens — its clone shares the handler
    // under an `Arc`; see [`NativeWebviewChannel`].
    let channel = app.state::<NativeWebviewChannel>().channel.clone();
    app.native_webview()
        .open_url(
            crate::SNIFFER_WEBVIEW_ID,
            OpenRequest {
                url: parsed.to_string(),
                init_script: Some(bootstrap.to_owned()),
                native_webview_event_channel: channel,
                // `initial_title` unset → page URL shows via the plugin's
                // URL-fallback; `initial_message` empty until a future step counts
                // resources. See this fn's doc for why the subtitle goes through
                // `open_url` rather than a post-open `patch_window_text`.
                initial_title: None,
                initial_subtitle: Some("Collecting Automatically".to_owned()),
                initial_message: None,
                // The sniffer targets arbitrary third-party EMR origins — never
                // seed any Wildflower credential into that jar.
                cookies: vec![],
                download_dir: sniffer_download_dir(app),
            },
        )
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview open_url failed: {error}"))?;

    // `open_url` never presents on its own (visibility is separate from content
    // under the hide/dispose model), so `show` after navigating to present.
    app.native_webview()
        .show(crate::SNIFFER_WEBVIEW_ID)
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview show failed: {error}"))?;

    Ok(())
}

/// Where the sniffer instance's page-initiated downloads land:
/// `<app data dir>/saved_data`, beside the rest of the captured data rather
/// than in the user's OS downloads folder. The plugin creates the directory
/// and picks the name; nothing about the download is under the page's control.
///
/// `None` when the platform resolves no app data directory — the plugin then
/// blocks downloads, which must not stop the scrape from opening at all.
fn sniffer_download_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => Some(dir.join("saved_data")),
        Err(error) => {
            log::warn!(
                "[browser-sniffer] no app data dir ({error}); opening the sniffer with downloads \
                 blocked"
            );
            None
        }
    }
}

/// Write `name` to the sniffer chrome's **subtitle** — the live replacement for
/// the static `"Collecting Automatically"` seed set at open time — so the user
/// can see which scripted step is running. Driven by the collector SPA's
/// `SetSnifferStatus` bridge message as each step begins.
///
/// `title` / `message` are left `None` (unchanged): the title keeps the plugin's
/// URL fallback and the bottom `message` slot stays reserved for a future
/// resource counter. `patch_window_text` is a no-op (`set: false`, never an
/// error) if no native webview is up or its chrome isn't built yet, so this may
/// be called speculatively without a race dance.
pub(crate) fn set_status(app: &AppHandle, name: String) -> anyhow::Result<()> {
    use tauri_plugin_native_webview::{NativeWebviewExt, PatchWindowTextRequest};

    app.native_webview()
        .patch_window_text(
            crate::SNIFFER_WEBVIEW_ID,
            PatchWindowTextRequest {
                title: None,
                subtitle: Some(name),
                message: None,
            },
        )
        .map_err(|error| {
            anyhow::anyhow!("tauri-plugin-native-webview patch_window_text failed: {error}")
        })?;

    Ok(())
}
