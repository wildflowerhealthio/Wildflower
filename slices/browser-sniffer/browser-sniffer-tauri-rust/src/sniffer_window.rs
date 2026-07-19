use tauri::{AppHandle, Manager, WebviewUrl};

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
