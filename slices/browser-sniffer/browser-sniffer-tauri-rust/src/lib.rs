//! Tauri host plumbing for the browser sniffer.
//!
//! Listens to three SPA-emitted CollectorBridge.webToHost events on the
//! global Tauri event bus and translates them into webview lifecycle
//! operations:
//!
//! - `bridge:RequestSniffableWebView` → create a sniffer
//!   [`tauri::WebviewWindow`] (top-level webview) sized to match the
//!   main window, with `browser-sniffer-tauri`'s bootstrap IIFE wired
//!   as `WebviewWindowBuilder::initialization_script(...)`.
//! - `bridge:Open` → navigate the existing sniffer webview to a new
//!   source (the init script re-runs on every navigation, so the
//!   sniffer re-installs idempotently).
//! - `bridge:SniffingComplete` → close the sniffer webview. The main
//!   webview's React SPA stays mounted.
//!
//! No Rust-side forwarding for the data plane. Sniffer-emitted
//! `bridge:ResponseStart`/`ResponseData`/`PageLoaded`/etc. land directly
//! on the main webview's `makeTauriTransport` listeners because Tauri
//! events broadcast to every webview AND to the Rust side — the
//! CollectorBridge re-exports BrowserSnifferBridge's webToHost schemas
//! as its own hostToWeb messages, so the tag names line up exactly.
//!
//! Why `WebviewWindow` and not `Window::add_child`: the latter is
//! gated behind `desktop + unstable` features in Tauri 2.11
//! (`tauri-2.11.2/src/window/mod.rs:1127`), so it does not compile for
//! mobile targets. `WebviewWindow` works across desktop and mobile —
//! on desktop the sniffer presents as a separate OS window, on mobile
//! as a separate native view/screen, matching the user's intent of
//! "open an iOS or Android webview over the existing app".

use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::log;

/// Event-name convention `bridge:{tag}` — must match the TS side in
/// `global/effect-messaging/effect-messaging-tauri/src/event-names.ts`.
/// Drift between Rust and TS is caught by the test in
/// [`tests::event_names_match_the_ts_convention`].
pub const REQUEST_SNIFFABLE_WEBVIEW_EVENT: &str = "bridge:RequestSniffableWebView";
pub const OPEN_EVENT: &str = "bridge:Open";
pub const SNIFFING_COMPLETE_EVENT: &str = "bridge:SniffingComplete";

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. The sniffer
/// child webview is added under this window so it overlays the SPA.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Label assigned to the sniffer child webview. Used to look up the
/// child for navigation and close operations; the same label re-used
/// on a second `RequestSniffableWebView` triggers a navigate-in-place
/// rather than a duplicate-child error.
pub const SNIFFER_WEBVIEW_LABEL: &str = "browser-sniffer";

/// IIFE bundle produced by `browser-sniffer-tauri`'s
/// `scripts/build-tauri-bootstrap.mts` build step — a self-contained
/// shim that translates the RN-WebView postMessage contract used by
/// the unmodified `installSniffer()` into Tauri `event.emit`/`listen`
/// calls.
///
/// The path is relative to this crate's `Cargo.toml`. The generated
/// file is gitignored; `vp install` triggers its creation via the
/// `prepare` script in `browser-sniffer-tauri/package.json`. A stale
/// or empty file fails the `bootstrap_is_non_empty` test below before
/// it can reach a real `WebviewBuilder`.
const SNIFFER_BOOTSTRAP: &str =
    include_str!("../../browser-sniffer-tauri/dist/tauri-bootstrap.js");

/// Wire shape of `CollectorBridge.webToHost.RequestSniffableWebView`,
/// pinned by `slices/collector/collector-fundamentals/src/bridge.ts`.
/// The `linkedSpan` field is decoded but unused at this layer — the
/// per-page span linkage is the React SPA's responsibility once
/// sniffer events flow back through `CollectorBridge.hostToWeb`.
#[derive(Debug, PartialEq, Deserialize)]
struct RequestSniffableWebViewPayload {
    source: WebViewSourcePayload,
}

/// Wire shape of `CollectorBridge.webToHost.Open`. Identical shape to
/// `RequestSniffableWebView` minus the optional `linkedSpan`, but split
/// into its own struct so future divergence (e.g. add a `clearStateFirst`
/// flag) doesn't accidentally couple the two.
#[derive(Debug, PartialEq, Deserialize)]
struct OpenPayload {
    source: WebViewSourcePayload,
}

/// Wire shape of the `WebViewSource` tagged union from
/// `slices/collector/collector-fundamentals/src/model/web-view-source.ts`.
/// The `Uri` variant carries an `https://`-only URL; we validate that
/// invariant at decode time as defense-in-depth alongside the SPA-side
/// schema check.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "_tag")]
enum WebViewSourcePayload {
    Uri(UriSource),
    Html(HtmlSource),
}

#[derive(Debug, PartialEq, Deserialize)]
struct UriSource {
    uri: String,
}

#[derive(Debug, PartialEq, Deserialize)]
struct HtmlSource {
    #[allow(dead_code)] // Html sources are not yet supported; see open_sniffer_webview.
    html: String,
    #[serde(rename = "baseUrl", default)]
    #[allow(dead_code)]
    base_url: Option<String>,
}

/// Errors raised while resolving a `WebViewSource` to a `WebviewUrl`.
/// Surfaces back to the caller via the listener's warn-and-drop path —
/// the SPA receives no acknowledgement (matching the
/// `effect-messaging-tauri` warn-and-drop convention for malformed
/// events) but the failure lands in the host log.
#[derive(Debug)]
enum SourceResolveError {
    NonHttpsUri(String),
    InvalidUri(String),
    HtmlNotSupported,
}

impl std::fmt::Display for SourceResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NonHttpsUri(uri) => write!(
                f,
                "WebViewSource.Uri must be https:// (got: {uri}); the SPA-side schema should have \
                 rejected this — investigate drift"
            ),
            Self::InvalidUri(uri) => write!(f, "WebViewSource.Uri could not be parsed: {uri}"),
            Self::HtmlNotSupported => write!(
                f,
                "WebViewSource.Html is not yet supported in Tauri; see the open question in the \
                 implementation plan"
            ),
        }
    }
}

fn resolve_source(source: WebViewSourcePayload) -> Result<WebviewUrl, SourceResolveError> {
    match source {
        WebViewSourcePayload::Uri(UriSource { uri }) => {
            if !uri.starts_with("https://") {
                return Err(SourceResolveError::NonHttpsUri(uri));
            }
            let parsed = url::Url::parse(&uri).map_err(|_| SourceResolveError::InvalidUri(uri))?;
            Ok(WebviewUrl::External(parsed))
        }
        WebViewSourcePayload::Html(_) => Err(SourceResolveError::HtmlNotSupported),
    }
}

/// Wire the three CollectorBridge.webToHost listeners onto Tauri's
/// event bus. Idempotent at the listener level — call once per app
/// lifecycle from `setup()`.
///
/// Listener callbacks decode the JSON payload, then dispatch. Decode
/// failures and webview operation failures log at warn (matching
/// `bridge.rs`'s `bridge:Log` handler convention) — the loop continues
/// to the next event.
pub fn attach_browser_sniffer(app: &AppHandle) {
    {
        let handle = app.clone();
        app.listen(REQUEST_SNIFFABLE_WEBVIEW_EVENT, move |event| {
            handle_request_sniffable_webview(&handle, event.payload());
        });
    }
    {
        let handle = app.clone();
        app.listen(OPEN_EVENT, move |event| {
            handle_open(&handle, event.payload());
        });
    }
    {
        let handle = app.clone();
        app.listen(SNIFFING_COMPLETE_EVENT, move |event| {
            // SniffingComplete carries an empty struct on the wire; no
            // decode needed beyond the listener firing.
            let _ = event;
            handle_sniffing_complete(&handle);
        });
    }
}

fn handle_request_sniffable_webview(app: &AppHandle, payload: &str) {
    let decoded = match serde_json::from_str::<RequestSniffableWebViewPayload>(payload) {
        Ok(decoded) => decoded,
        Err(error) => {
            log::warn!(
                "[browser-sniffer] undecodable {REQUEST_SNIFFABLE_WEBVIEW_EVENT} payload dropped: \
                 {error}"
            );
            return;
        }
    };
    let url = match resolve_source(decoded.source) {
        Ok(url) => url,
        Err(error) => {
            log::warn!("[browser-sniffer] cannot resolve RequestSniffableWebView source: {error}");
            return;
        }
    };
    if let Err(error) = open_or_navigate_sniffer_webview(app, url) {
        log::error!("[browser-sniffer] failed to open sniffer webview: {error}");
    }
}

fn handle_open(app: &AppHandle, payload: &str) {
    let decoded = match serde_json::from_str::<OpenPayload>(payload) {
        Ok(decoded) => decoded,
        Err(error) => {
            log::warn!("[browser-sniffer] undecodable {OPEN_EVENT} payload dropped: {error}");
            return;
        }
    };
    let url = match resolve_source(decoded.source) {
        Ok(url) => url,
        Err(error) => {
            log::warn!("[browser-sniffer] cannot resolve Open source: {error}");
            return;
        }
    };
    // `Open` is a navigate-in-place: the SPA assumes the sniffer webview
    // is already mounted (typically follows a RequestSniffableWebView).
    // If the webview is missing we fall through to opening a fresh one,
    // matching the Expo collector-expo behaviour where setting a new
    // `pendingSource` re-mounts the WebView component if needed.
    if let Err(error) = open_or_navigate_sniffer_webview(app, url) {
        log::error!("[browser-sniffer] failed to (re)navigate sniffer webview: {error}");
    }
}

fn handle_sniffing_complete(app: &AppHandle) {
    let Some(webview_window) = app.get_webview_window(SNIFFER_WEBVIEW_LABEL) else {
        // SPA emitted SniffingComplete without an open sniffer webview —
        // legal at the bridge level (e.g. SPA decided "done" before
        // RequestSniffableWebView fired), just nothing to close.
        log::debug!(
            "[browser-sniffer] {SNIFFING_COMPLETE_EVENT} received but no '{SNIFFER_WEBVIEW_LABEL}' \
             webview window is open; ignoring"
        );
        return;
    };
    if let Err(error) = webview_window.close() {
        log::error!("[browser-sniffer] failed to close sniffer webview: {error}");
    }
}

/// Open the sniffer webview as a top-level `WebviewWindow` if it does
/// not exist; otherwise navigate the existing webview to `url`.
///
/// On desktop the sniffer presents as a separate OS window sized to
/// match the main window (so it visually mimics an overlay), on mobile
/// as a separate screen. The cross-platform path is `WebviewWindow`
/// (top-level) — `Window::add_child` is desktop+unstable only in Tauri
/// 2.11 and would not compile for mobile targets.
///
/// Idempotent re-injection is safe at the JS level — the sniffer's
/// `Symbol.for('browser-sniffer:state')` slot short-circuits a second
/// `installSniffer()` call on the same page — so a
/// `RequestSniffableWebView` arriving while a sniffer webview is
/// already mounted simply triggers a navigation. This matches the
/// collector-expo behaviour where the modal screen swaps
/// `pendingSource` rather than tearing down the component.
fn open_or_navigate_sniffer_webview(app: &AppHandle, url: WebviewUrl) -> anyhow::Result<()> {
    if let Some(existing) = app.get_webview_window(SNIFFER_WEBVIEW_LABEL) {
        let parsed = match url {
            WebviewUrl::External(parsed) => parsed,
            _ => {
                anyhow::bail!(
                    "non-External WebviewUrl handed to navigate path — only Uri sources are \
                     supported today"
                )
            }
        };
        existing.navigate(parsed)?;
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(app, SNIFFER_WEBVIEW_LABEL, url)
        .initialization_script(SNIFFER_BOOTSTRAP)
        .title("Wildflower Sniffer");

    // On desktop, size and place the sniffer window to match the main
    // window so it visually mimics an overlay even though it is a
    // separate OS window. On mobile this branch is skipped — the OS
    // controls presentation of a new webview (typically a fullscreen
    // screen push), which is the intended user experience.
    #[cfg(desktop)]
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let (Ok(physical_size), Ok(scale)) = (main.inner_size(), main.scale_factor()) {
            let logical = physical_size.to_logical::<f64>(scale);
            builder = builder.inner_size(logical.width, logical.height);
        }
        if let (Ok(physical_pos), Ok(scale)) = (main.outer_position(), main.scale_factor()) {
            let logical = physical_pos.to_logical::<f64>(scale);
            builder = builder.position(logical.x, logical.y);
        }
    }

    builder.build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard: the TS side pins the same literals via
    /// `bridge:{tag}` where `tag` is the bridge schema's tag name.
    #[test]
    fn event_names_match_the_ts_convention() {
        assert_eq!(REQUEST_SNIFFABLE_WEBVIEW_EVENT, "bridge:RequestSniffableWebView");
        assert_eq!(OPEN_EVENT, "bridge:Open");
        assert_eq!(SNIFFING_COMPLETE_EVENT, "bridge:SniffingComplete");
    }

    /// The bootstrap IIFE is generated at build time. An empty file
    /// silently injects a no-op into the sniffer webview; surface it
    /// loudly here so a missing `vp install` (which runs the generator
    /// via the package's `prepare` script) fails the test suite rather
    /// than reaching runtime.
    #[test]
    fn bootstrap_is_non_empty() {
        assert!(
            SNIFFER_BOOTSTRAP.len() > 1000,
            "SNIFFER_BOOTSTRAP is {} bytes; expected >1000. The generated file at \
             slices/browser-sniffer/browser-sniffer-tauri/dist/tauri-bootstrap.js looks empty or \
             stale — run `vp install` or `vp run generate-tauri-bootstrap` in that package.",
            SNIFFER_BOOTSTRAP.len(),
        );
    }

    #[test]
    fn request_sniffable_webview_decodes_uri_source() {
        let payload = r#"{"_tag":"RequestSniffableWebView","source":{"_tag":"Uri","uri":"https://example.test/"}}"#;
        let decoded: RequestSniffableWebViewPayload =
            serde_json::from_str(payload).expect("decode");
        assert_eq!(
            decoded,
            RequestSniffableWebViewPayload {
                source: WebViewSourcePayload::Uri(UriSource {
                    uri: "https://example.test/".to_string(),
                }),
            }
        );
    }

    #[test]
    fn open_decodes_uri_source() {
        let payload = r#"{"_tag":"Open","source":{"_tag":"Uri","uri":"https://example.test/next"}}"#;
        let decoded: OpenPayload = serde_json::from_str(payload).expect("decode");
        assert_eq!(
            decoded,
            OpenPayload {
                source: WebViewSourcePayload::Uri(UriSource {
                    uri: "https://example.test/next".to_string(),
                }),
            }
        );
    }

    #[test]
    fn resolve_source_rejects_non_https_uri() {
        let source = WebViewSourcePayload::Uri(UriSource {
            uri: "http://example.test/".to_string(),
        });
        let error = resolve_source(source).expect_err("expected rejection");
        assert!(
            matches!(error, SourceResolveError::NonHttpsUri(uri) if uri == "http://example.test/"),
        );
    }

    #[test]
    fn resolve_source_accepts_https_uri() {
        let source = WebViewSourcePayload::Uri(UriSource {
            uri: "https://example.test/page".to_string(),
        });
        let resolved = resolve_source(source).expect("expected success");
        match resolved {
            WebviewUrl::External(url) => {
                assert_eq!(url.as_str(), "https://example.test/page");
            }
            _ => panic!("expected WebviewUrl::External"),
        }
    }

    #[test]
    fn resolve_source_reports_html_as_unsupported() {
        let source = WebViewSourcePayload::Html(HtmlSource {
            html: "<html><body>hi</body></html>".to_string(),
            base_url: None,
        });
        let error = resolve_source(source).expect_err("expected rejection");
        assert!(matches!(error, SourceResolveError::HtmlNotSupported));
    }

    #[test]
    fn web_view_source_decodes_html_with_optional_base_url() {
        let payload =
            r#"{"_tag":"Html","html":"<html></html>","baseUrl":"https://issuer.test/"}"#;
        let decoded: WebViewSourcePayload = serde_json::from_str(payload).expect("decode");
        assert_eq!(
            decoded,
            WebViewSourcePayload::Html(HtmlSource {
                html: "<html></html>".to_string(),
                base_url: Some("https://issuer.test/".to_string()),
            }),
        );
    }

    #[test]
    fn web_view_source_decodes_html_without_base_url() {
        let payload = r#"{"_tag":"Html","html":"<html></html>"}"#;
        let decoded: WebViewSourcePayload = serde_json::from_str(payload).expect("decode");
        assert_eq!(
            decoded,
            WebViewSourcePayload::Html(HtmlSource {
                html: "<html></html>".to_string(),
                base_url: None,
            }),
        );
    }

    #[test]
    fn window_labels_match_tauri_conf() {
        // tauri.conf.json's window default label is "main" when none is
        // set in `app.windows[].label`. The existing bridge.rs pins the
        // same literal — drift here would also break the consent popup
        // raise path.
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        // The sniffer label is internal to this crate; tests in the
        // wildflower-tauri integration layer can rely on it.
        assert_eq!(SNIFFER_WEBVIEW_LABEL, "browser-sniffer");
    }
}
