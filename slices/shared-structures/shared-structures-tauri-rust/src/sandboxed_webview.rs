//! A generic, less-privileged top-level webview for loading arbitrary external
//! (non-Tauri) pages.
//!
//! Copied from `browser-sniffer-tauri-rust`'s `sniffer_window` and generalised
//! — the bootstrap-injection and sniffer-specific labels are dropped, leaving a
//! reusable "open this untrusted URL in a sandboxed window" primitive. The page
//! loaded here only gets whatever the composing app's
//! `capabilities/sandboxed-webview.json` grants (deliberately *not*
//! `core:default`, and never the gated owner-token command), so a hostile
//! external page can't reach the host APIs the main webview holds.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// Label assigned to the shared sandboxed webview. The matching capability
/// JSON in the composing app keys on this label to scope the reduced grant;
/// callers also use it to look the window up for navigation / close.
pub const SANDBOXED_WEBVIEW_LABEL: &str = "sandboxed-webview";

/// Sentinel for whether *we* believe the sandboxed window is open.
///
/// `WebviewWindow::close()` is a request to the platform, not a synchronous
/// teardown — Tauri's `get_webview_window(label)` may still find a closing
/// window for one or more event-loop ticks. Serialising the open/close decision
/// against our own state (flip to `false` before asking Tauri to close) means a
/// reopen that races a close always takes the build-fresh path rather than
/// navigating a doomed window. Mirrors the sniffer's `SNIFFER_OPEN` rationale.
static SANDBOXED_OPEN: AtomicBool = AtomicBool::new(false);

/// Parse an `http(s)://`-only URL into a [`WebviewUrl`] suitable for
/// [`open_or_navigate`]. Both schemes are accepted (a dev server reachable only
/// over `http` is still loadable); anything else is rejected. Defense-in-depth:
/// callers should already have validated their source.
///
/// # Errors
///
/// Returns an error when `uri` is not `http(s)://` or does not parse as a URL.
pub fn resolve_http_url(uri: &str) -> anyhow::Result<WebviewUrl> {
    if !uri.starts_with("https://") && !uri.starts_with("http://") {
        anyhow::bail!("sandboxed webview URL must be http(s):// (got: {uri})");
    }
    let parsed = Url::parse(uri).map_err(|error| {
        anyhow::anyhow!("sandboxed webview URL could not be parsed: {uri} ({error})")
    })?;
    Ok(WebviewUrl::External(parsed))
}

/// Mark the sandboxed slot free. Returns the previous open/closed state.
pub fn mark_closed() -> bool {
    SANDBOXED_OPEN.swap(false, Ordering::SeqCst)
}

/// Open the sandboxed webview as a top-level `WebviewWindow` if our own
/// sentinel says the slot is free; otherwise navigate the existing webview to
/// `url`.
///
/// Cross-platform: `WebviewWindow` works on desktop *and* mobile, whereas
/// `Window::add_child` is gated behind `desktop + unstable` in Tauri 2.11 and
/// wouldn't compile for iOS / Android targets. On desktop the page presents as
/// a separate OS window; on mobile as a separate screen.
///
/// # Errors
///
/// Returns an error if a non-`External` `url` reaches the navigate path, or if
/// Tauri fails to build the window / navigate the existing one.
pub fn open_or_navigate(app: &AppHandle, url: WebviewUrl) -> anyhow::Result<()> {
    if SANDBOXED_OPEN.load(Ordering::SeqCst) {
        if let Some(existing) = app.get_webview_window(SANDBOXED_WEBVIEW_LABEL) {
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

    // Leave window placement and sizing to the OS / Tauri default, matching the
    // sniffer window: copying the main window's geometry needs a
    // `#[cfg(desktop)]` gate that only `tauri-build` sets, and this crate has no
    // build script.
    WebviewWindowBuilder::new(app, SANDBOXED_WEBVIEW_LABEL, url)
        .title("Wildflower")
        .build()?;
    SANDBOXED_OPEN.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_sandboxed_webview() {
        // Internal label; the capability JSON's `windows`/`webviews` arrays and
        // any close/navigate lookup rely on it.
        assert_eq!(SANDBOXED_WEBVIEW_LABEL, "sandboxed-webview");
    }

    #[test]
    fn resolve_http_url_accepts_http_and_https() {
        for uri in [
            "https://example.test/page",
            "http://localhost:8080/fhir/Patient/1",
        ] {
            match resolve_http_url(uri).expect("should resolve") {
                WebviewUrl::External(url) => assert_eq!(url.as_str(), uri),
                other => panic!("expected External, got {other:?}"),
            }
        }
    }

    #[test]
    fn resolve_http_url_rejects_non_http_schemes() {
        for uri in ["ftp://example.test/", "javascript:alert(1)", "file:///etc"] {
            assert!(
                resolve_http_url(uri).is_err(),
                "{uri} should have been rejected",
            );
        }
    }

    #[test]
    fn mark_closed_returns_previous_state_and_is_idempotent() {
        // Mirrors the sniffer's sentinel test: set known state, observe,
        // restore — order-independent under cargo's default per-module
        // serialisation.
        let prior = SANDBOXED_OPEN.swap(true, Ordering::SeqCst);
        assert!(mark_closed(), "mark_closed should report previous-open");
        assert!(!mark_closed(), "second mark_closed is a no-op");
        SANDBOXED_OPEN.store(prior, Ordering::SeqCst);
    }
}
