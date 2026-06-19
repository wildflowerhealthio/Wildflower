use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::bootstrap::SNIFFER_BOOTSTRAP;

/// Label assigned to the sniffer webview. Used to look up the window
/// for navigation and close operations.
pub const SNIFFER_WEBVIEW_LABEL: &str = "browser-sniffer";

/// Sentinel for whether *we* believe the sniffer window is open.
///
/// `WebviewWindow::close()` is a request to the platform, not a
/// synchronous teardown — Tauri's `get_webview_window(label)` may still
/// find a closing window for one or more event-loop ticks. If the SPA
/// emits `SniffingComplete` immediately followed by a fresh
/// `RequestSniffableWebView` (UX example: "switch demos"), the lookup
/// race could route the second event into the navigate-in-place branch
/// against a doomed window — the SPA would never see the new sniffer.
///
/// We resolve the race by serialising the open/close decision against
/// our own state, not Tauri's destruction lifecycle: the close handler
/// flips this to `false` *before* asking Tauri to close, so a follow-up
/// open always takes the build-fresh path.
static SNIFFER_OPEN: AtomicBool = AtomicBool::new(false);

/// Mark the sniffer slot free. Returns the previous open/closed state.
pub(crate) fn mark_closed() -> bool {
    SNIFFER_OPEN.swap(false, Ordering::SeqCst)
}

/// Open the sniffer webview as a top-level `WebviewWindow` if our own
/// sentinel says the slot is free; otherwise navigate the existing
/// webview to `url`.
///
/// Cross-platform: `WebviewWindow` works on desktop *and* mobile,
/// whereas `Window::add_child` is gated behind `desktop + unstable` in
/// Tauri 2.11 and wouldn't compile for iOS / Android targets. On desktop
/// the sniffer presents as a separate OS window; on mobile as a separate
/// screen.
///
/// Idempotent re-injection of the bootstrap is safe at the JS level —
/// `installSniffer()`'s `Symbol.for('browser-sniffer:state')` slot
/// short-circuits a second install on the same page — so a
/// `RequestSniffableWebView` arriving while the sniffer is already
/// mounted simply triggers a navigation.
pub(crate) fn open_or_navigate(app: &AppHandle, url: WebviewUrl) -> anyhow::Result<()> {
    if SNIFFER_OPEN.load(Ordering::SeqCst) {
        if let Some(existing) = app.get_webview_window(SNIFFER_WEBVIEW_LABEL) {
            let WebviewUrl::External(parsed) = url else {
                anyhow::bail!(
                    "non-External WebviewUrl handed to navigate path — only Uri sources are \
                     supported today"
                )
            };
            existing.navigate(parsed)?;
            return Ok(());
        }
    }

    // Leave window placement and sizing to the OS / Tauri default. On
    // mobile the OS owns presentation (typically a fullscreen screen
    // push); on desktop a centred separate window is acceptable for v1.
    // Copying the main window's geometry needed a `#[cfg(desktop)]` gate
    // that is set only by `tauri-build` — this crate has no build script,
    // so the cfg was undeclared and clippy's `unexpected_cfgs` lint
    // refused the workspace build.
    WebviewWindowBuilder::new(app, SNIFFER_WEBVIEW_LABEL, url)
        .initialization_script(SNIFFER_BOOTSTRAP)
        .title("Wildflower Collector")
        .build()?;
    SNIFFER_OPEN.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_browser_sniffer() {
        // Internal label; integration tests in the wildflower-tauri layer
        // (and the capability JSON's `webviews` array) rely on it.
        assert_eq!(SNIFFER_WEBVIEW_LABEL, "browser-sniffer");
    }

    #[test]
    fn mark_closed_returns_previous_state_and_is_idempotent() {
        // This test mutates the global sentinel; it relies on serial
        // execution by cargo test's default single-threaded ordering per
        // module. The assertion is structured to be order-independent:
        // we set known state, observe, then restore.
        let prior = SNIFFER_OPEN.swap(true, Ordering::SeqCst);
        assert!(mark_closed(), "mark_closed should report previous-open");
        assert!(!mark_closed(), "second mark_closed is a no-op");
        SNIFFER_OPEN.store(prior, Ordering::SeqCst);
    }
}
