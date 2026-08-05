//! Sniffer-specific tag literals dispatched on the multiplexed bridge
//! channel. The channel name (`BRIDGE_EVENT`), envelope shape, and the
//! single-channel/FIFO rationale live in [`shared_structures_rust::bridge`];
//! this module only owns the per-crate tag literals and window labels.

/// Web→host tag literals this crate dispatches on.
pub const REQUEST_SNIFFABLE_WEBVIEW: &str = "RequestSniffableWebView";
pub const OPEN: &str = "Open";
pub const SNIFFING_COMPLETE: &str = "SniffingComplete";

/// Web→host control tag: set the sniffer chrome's subtitle to the current
/// step's name. Host-consumed on every platform (routed to
/// `patch_window_text`), never forwarded into the sniffed page.
pub const SET_SNIFFER_STATUS: &str = "SetSnifferStatus";

/// Web→host: the SPA asks the host to (re-)present the existing sniffer webview
/// (a fire-and-advance `EnsureWindowVisible` step). Maps to
/// `native_webview().show(SNIFFER_WEBVIEW_ID)` — re-presents a hidden-but-alive
/// webview without navigating; idempotent no-op if none exists. Mirrors
/// `collector-fundamentals`'s `CollectorBridge` `EnsureSnifferVisible` message.
pub const ENSURE_SNIFFER_VISIBLE: &str = "EnsureSnifferVisible";

/// Web→host *data-plane* tag literals the sniffer's native-webview page
/// legitimately posts (the page-observation stream the SPA collector consumes).
/// These are the ONLY inner `_tag`s `native_webview_bridge` re-emits from an
/// untrusted native-webview `Message` — control tags are deliberately excluded
/// so a hostile page can't spoof them (see `native_webview_bridge`). Mirrors
/// `browser-sniffer-core`'s `messages.ts` page→host set plus the `Log`
/// console-shim tag; drift-guarded in `native_webview_bridge::tests`.
pub const PAGE_LOADED: &str = "PageLoaded";
/// Early page-arrival notification: emitted once per document at
/// `DOMContentLoaded`, before (and even without) the settled `PAGE_LOADED`.
pub const PAGE_REQUESTED: &str = "PageRequested";
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
///
/// `PageAction` is the single scripted-interaction tag (the sniffer demuxes
/// its inner `action.kind` into a `Click` / `Fill`); the host never decodes
/// the payload, only forwards it verbatim by `_tag`.
pub const PAGE_ACTION: &str = "PageAction";
pub const CANCEL_SNIFFER_REQUEST: &str = "CancelSnifferRequest";

/// Host→web control tag the crate *synthesizes* from a plugin `Hidden` lifecycle
/// event (the user dismissed / closed the sniffer webview) and emits on
/// `BRIDGE_EVENT` for the collector SPA. It is host-originated, not a page
/// observation, so it is deliberately **excluded** from
/// [`crate::native_webview_bridge`]'s page→host data-plane allowlist — an
/// untrusted page must not be able to forge it. Drift-guarded in
/// [`crate::tests::bridge_tags_match_the_ts_convention`]; mirrors
/// `collector-fundamentals`'s `CollectorBridge` `UserDismissed` message.
pub const USER_DISMISSED: &str = "UserDismissed";

/// Host→web control tag the crate *synthesizes* from a plugin `Disposed`
/// lifecycle event (the sniffer webview was torn down). Kept distinct from
/// [`USER_DISMISSED`] on purpose: a dispose is also what this run's own
/// `SniffingComplete` teardown produces, so one arrives on every run and folding
/// it into the dismissal signal would race ordinary shutdown. Host-originated
/// like `UserDismissed`, so it is likewise **excluded** from
/// [`crate::native_webview_bridge`]'s page→host data-plane allowlist.
/// Drift-guarded in [`crate::tests::bridge_tags_match_the_ts_convention`];
/// mirrors `collector-fundamentals`'s `CollectorBridge` `SnifferDisposed`
/// message.
pub const SNIFFER_DISPOSED: &str = "SnifferDisposed";

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. Re-exported so
/// integration tests can drift-guard against a config rename; not
/// referenced at runtime in this crate (the sniffer opens as a peer
/// top-level window — the plugin's `native-webview` window — not a child of the
/// main window).
pub const MAIN_WINDOW_LABEL: &str = "main";
