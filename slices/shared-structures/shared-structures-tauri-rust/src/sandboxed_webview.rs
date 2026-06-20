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

use shared_structures_rust::bridge::BRIDGE_EVENT;
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::log;
use url::Url;

use crate::bootstrap::SANDBOXED_WEBVIEW_BOOTSTRAP;

/// Web→host tag the sandboxed-webview top bar emits when the user dismisses the
/// window (Close, or Back with no history left). Pinned against the TS literal
/// in `shared-structures-tauri/src/bridge-tags.ts`
/// (`CLOSE_SANDBOXED_WEBVIEW_TAG`) by `close_tag_matches_the_ts_convention`.
pub const CLOSE_SANDBOXED_WEBVIEW_TAG: &str = "CloseSandboxedWebView";

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
        // Inject the shared top-bar bootstrap so the user gets Back / Reload /
        // URL chrome (and a way to dismiss the window) on platforms where a
        // WebviewWindow presents as a chrome-less full-screen native screen.
        // Idempotent at the JS level — the bar's `hostId` slot short-circuits a
        // second injection on the same page — so a re-navigation is safe.
        .initialization_script(SANDBOXED_WEBVIEW_BOOTSTRAP)
        .title("Wildflower")
        .build()?;
    SANDBOXED_OPEN.store(true, Ordering::SeqCst);
    Ok(())
}

/// Close the sandboxed webview. Flip the open/close sentinel *before* asking
/// Tauri to close, so a follow-up open arriving during the close tick always
/// lands on the fresh-open path (see [`open_or_navigate`] for the race
/// rationale). A no-op if no window is found (already closed by another path).
pub fn close(app: &AppHandle) {
    let was_open = mark_closed();
    let Some(window) = app.get_webview_window(SANDBOXED_WEBVIEW_LABEL) else {
        if was_open {
            log::debug!(
                "[sandboxed-webview] sentinel was open but no '{SANDBOXED_WEBVIEW_LABEL}' webview \
                 found — already closed by another path"
            );
        }
        return;
    };
    if let Err(error) = window.close() {
        log::error!("[sandboxed-webview] failed to close webview: {error}");
    }
}

/// Wire the close listener: when the in-page top bar emits
/// `CloseSandboxedWebView` on the multiplexed bridge channel, close the window.
///
/// Idempotent at the listener level — call once per app lifecycle from
/// `setup()`. The bridge channel is shared across listeners; this one decodes
/// only the envelope's `_tag` and acts solely on [`CLOSE_SANDBOXED_WEBVIEW_TAG`],
/// dropping every other tag (sibling slices' traffic, host→web echoes).
pub fn attach_close_listener(app: &AppHandle) {
    log::info!(
        "[sandboxed-webview] listening on '{BRIDGE_EVENT}' for tag: [{CLOSE_SANDBOXED_WEBVIEW_TAG}]"
    );
    let handle = app.clone();
    app.listen(BRIDGE_EVENT, move |event| {
        if is_close_request(event.payload()) {
            close(&handle);
        }
    });
}

/// Whether a bridge envelope is the `CloseSandboxedWebView` web→host message.
/// Decodes only the `_tag`, so unrelated traffic and malformed payloads are
/// ignored.
fn is_close_request(payload: &str) -> bool {
    #[derive(serde::Deserialize)]
    struct TagOnly {
        #[serde(rename = "_tag")]
        tag: String,
    }
    serde_json::from_str::<TagOnly>(payload)
        .map(|message| message.tag == CLOSE_SANDBOXED_WEBVIEW_TAG)
        .unwrap_or(false)
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

    #[test]
    fn close_tag_matches_the_ts_convention() {
        // Pinned against `CLOSE_SANDBOXED_WEBVIEW_TAG` in
        // `shared-structures-tauri/src/bridge-tags.ts`.
        assert_eq!(CLOSE_SANDBOXED_WEBVIEW_TAG, "CloseSandboxedWebView");
    }

    #[test]
    fn is_close_request_matches_only_the_close_tag() {
        assert!(is_close_request(r#"{"_tag":"CloseSandboxedWebView"}"#));
        // Sibling slices' traffic, host→web echoes, and malformed payloads.
        assert!(!is_close_request(r#"{"_tag":"RequestSandboxedWebView","url":"x"}"#));
        assert!(!is_close_request(r#"{"_tag":"SniffingComplete"}"#));
        assert!(!is_close_request(r#"{"_tag":42}"#));
        assert!(!is_close_request("not json"));
    }

    /// The bootstrap IIFE is generated at build time. An empty file silently
    /// injects a no-op into the sandboxed webview; surface it loudly here so a
    /// missing regeneration step fails the suite before runtime. Mirrors the
    /// sniffer crate's `bootstrap_is_non_empty`.
    #[test]
    fn bootstrap_is_non_empty() {
        assert!(
            SANDBOXED_WEBVIEW_BOOTSTRAP.len() > 1000,
            "SANDBOXED_WEBVIEW_BOOTSTRAP is {} bytes; expected >1000. The generated file at \
             slices/shared-structures/shared-structures-tauri/dist/tauri-bootstrap.js looks empty \
             or stale — run `vp install` or `vp run generate-tauri-bootstrap` in that package.",
            SANDBOXED_WEBVIEW_BOOTSTRAP.len(),
        );
    }
}
