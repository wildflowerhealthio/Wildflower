use tauri::{AppHandle, Manager, WebviewUrl};

#[cfg(any(target_os = "ios", target_os = "android"))]
use crate::bootstrap::NATIVE_SNIFFER_BOOTSTRAP;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use crate::bootstrap::SNIFFER_BOOTSTRAP;

/// Present the sniffer popup via `tauri-plugin-native-webview` on every
/// target. The plugin owns popup chrome (native toolbar on iOS / Android,
/// a multi-webview chrome bar on desktop), so the same call site works
/// across platforms — only the document-start `installSniffer` bootstrap
/// differs: mobile content webviews use the native-bridge variant
/// (`webkit.messageHandlers.nativeWebview` / `window.nativeWebview`),
/// desktop content webviews use the Tauri event-bus variant
/// (`__TAURI__.event`).
///
/// The plugin's `open` is idempotent: a second call while a popup is up
/// navigates the existing content webview to `url` rather than stacking a
/// new presentation. The sniffer leaves `initial_title` unset (so the page URL
/// shows in the title via the plugin's URL-fallback) and passes
/// `subtitle: "Collecting Automatically"` as the `open` request's
/// `initial_subtitle` so it paints with the popup (rather than a post-open
/// `patch_window_text`, which on desktop would race the not-yet-built chrome
/// webview).
pub(crate) fn open_or_navigate(app: &AppHandle, url: WebviewUrl) -> anyhow::Result<()> {
    use tauri_plugin_native_webview::{NativeWebviewExt, OpenRequest};

    use crate::popup_bridge::PopupChannel;

    let WebviewUrl::External(parsed) = url else {
        anyhow::bail!(
            "non-External WebviewUrl handed to native popup path — only Uri sources are \
             supported today"
        )
    };

    // The popup-side `installSniffer` IIFE — content-only, no in-page top
    // bar. Both the desktop (Tauri) and mobile (native bridges) variants
    // gate themselves on the appropriate transport and run the same
    // sniffer body underneath.
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let bootstrap = NATIVE_SNIFFER_BOOTSTRAP;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let bootstrap = SNIFFER_BOOTSTRAP;

    // `Channel` clones share the same identifier and handler under an `Arc`,
    // so reusing the long-lived channel across opens routes every popup's
    // events to the same `popup_bridge` handler.
    let channel = app.state::<PopupChannel>().channel.clone();
    app.native_webview()
        .open(OpenRequest {
            url: parsed.to_string(),
            init_script: Some(bootstrap.to_owned()),
            native_webview_event_channel: channel,
            // Bake the sniffer's static status into the chrome subtitle at
            // presentation time. `initial_title` is left unset so the page URL
            // shows in the title (plugin URL-fallback); message stays empty
            // until a future step counts resources (e.g. "34 resources
            // collected"). Applying it through `open` rather than a post-open
            // `patch_window_text` means it paints with the popup and avoids the
            // desktop race where `patch_window_text` lands before the chrome
            // webview is built.
            initial_title: None,
            initial_subtitle: Some("Collecting Automatically".to_owned()),
            initial_message: None,
        })
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview open failed: {error}"))?;

    Ok(())
}
