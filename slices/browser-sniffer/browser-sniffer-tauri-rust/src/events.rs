//! Sniffer-specific tag literals dispatched on the multiplexed bridge
//! channel. The channel name (`BRIDGE_EVENT`), envelope shape, and the
//! single-channel/FIFO rationale live in [`shared_structures_rust::bridge`];
//! this module only owns the per-crate tag literals and window labels.

/// Web→host tag literals this crate dispatches on.
pub const REQUEST_SNIFFABLE_WEBVIEW: &str = "RequestSniffableWebView";
pub const OPEN: &str = "Open";
pub const SNIFFING_COMPLETE: &str = "SniffingComplete";

/// Web→host *data-plane* tag literals the sniffer's native-webview page
/// legitimately posts over the bridge (the page-observation stream the SPA
/// collector consumes). These are the ONLY inner `_tag`s `native_webview_bridge`
/// will re-emit from an untrusted native-webview `Message`: the native webview
/// loads an arbitrary third-party URL whose scripts can reach the native bridge
/// directly, so control tags (`SniffingComplete`, `Open`,
/// `RequestSniffableWebView`) are deliberately excluded — re-emitting one would
/// let a hostile page spoof a sibling slice's control event or prematurely end
/// sniffing. Mirrors `browser-sniffer-core`'s `messages.ts` page→host set plus
/// the `Log` console-shim tag from `install-sniffer.ts`; the drift guard in
/// `native_webview_bridge::tests` pins them.
pub const PAGE_LOADED: &str = "PageLoaded";
pub const RESPONSE_START: &str = "ResponseStart";
pub const RESPONSE_DATA: &str = "ResponseData";
pub const RESPONSE_FINISHED: &str = "ResponseFinished";
pub const REQUEST_ERROR: &str = "RequestError";
pub const CANCELLED: &str = "Cancelled";
pub const LOG: &str = "Log";

/// Host→web tag literals this crate forwards into the native webview on
/// mobile. On desktop these are picked up by the content webview's own Tauri
/// event-bus listener (it holds an `allow-listen` grant) — no Rust forwarding
/// needed — so the cfg(mobile) handlers in `lib.rs` are the only callers.
pub const CLICK: &str = "Click";
pub const CANCEL_SNIFFER_REQUEST: &str = "CancelSnifferRequest";

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. Re-exported so
/// integration tests can drift-guard against a config rename; not
/// referenced at runtime in this crate (the sniffer opens as a peer
/// top-level window — the plugin's `native-webview` window — not a child of the
/// main window).
pub const MAIN_WINDOW_LABEL: &str = "main";
