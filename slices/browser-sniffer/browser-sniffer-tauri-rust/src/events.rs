//! Sniffer-specific tag literals dispatched on the multiplexed bridge
//! channel. The channel name (`BRIDGE_EVENT`), envelope shape, and the
//! single-channel/FIFO rationale live in [`shared_structures_rust::bridge`];
//! this module only owns the per-crate tag literals and window labels.

/// Web→host tag literals this crate dispatches on.
pub const REQUEST_SNIFFABLE_WEBVIEW: &str = "RequestSniffableWebView";
pub const OPEN: &str = "Open";
pub const SNIFFING_COMPLETE: &str = "SniffingComplete";

/// Web→host *data-plane* tag literals the sniffer's native-webview page
/// legitimately posts (the page-observation stream the SPA collector consumes).
/// These are the ONLY inner `_tag`s `native_webview_bridge` re-emits from an
/// untrusted native-webview `Message` — control tags are deliberately excluded
/// so a hostile page can't spoof them (see `native_webview_bridge`). Mirrors
/// `browser-sniffer-core`'s `messages.ts` page→host set plus the `Log`
/// console-shim tag; drift-guarded in `native_webview_bridge::tests`.
pub const PAGE_LOADED: &str = "PageLoaded";
pub const RESPONSE_START: &str = "ResponseStart";
pub const RESPONSE_DATA: &str = "ResponseData";
pub const RESPONSE_FINISHED: &str = "ResponseFinished";
pub const REQUEST_ERROR: &str = "RequestError";
pub const CANCELLED: &str = "Cancelled";
pub const LOG: &str = "Log";
/// The sniffer's answer to a [`QUERY_MATCHES`] discovery request: the nodes a
/// `querySelectorAll` matched, backing the collector's `ForEach` runtime link
/// discovery. A data-plane tag like the `Response*` set — the page raises it,
/// the host re-emits it verbatim (see `native_webview_bridge`).
pub const MATCHES_FOUND: &str = "MatchesFound";

/// Host→web tag literals this crate forwards into the native webview on
/// mobile. On desktop these are picked up by the content webview's own Tauri
/// event-bus listener (it holds an `allow-listen` grant) — no Rust forwarding
/// needed — so the cfg(mobile) handlers in `lib.rs` are the only callers.
///
/// `PageAction` is the single scripted-interaction tag (the sniffer demuxes
/// its inner `action.kind` into a `Click` / `Fill`); the host never decodes
/// the payload, only forwards it verbatim by `_tag`. `QueryMatches` is the
/// discovery request behind the collector's `ForEach` fan-out — the host
/// forwards it the same way, and the sniffer answers with a `MatchesFound`
/// ([`MATCHES_FOUND`]) on the data plane.
pub const PAGE_ACTION: &str = "PageAction";
pub const QUERY_MATCHES: &str = "QueryMatches";
pub const CANCEL_SNIFFER_REQUEST: &str = "CancelSnifferRequest";

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. Re-exported so
/// integration tests can drift-guard against a config rename; not
/// referenced at runtime in this crate (the sniffer opens as a peer
/// top-level window — the plugin's `native-webview` window — not a child of the
/// main window).
pub const MAIN_WINDOW_LABEL: &str = "main";
