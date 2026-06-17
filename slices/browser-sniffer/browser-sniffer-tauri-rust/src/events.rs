//! Event-name constants. Convention `bridge:{tag}` — must match the TS
//! side in
//! `global/effect-messaging/effect-messaging-tauri/src/event-names.ts`.
//! Drift between Rust and TS is caught by `event_names_match_the_ts_convention`
//! in `lib.rs`.

pub const REQUEST_SNIFFABLE_WEBVIEW_EVENT: &str = "bridge:RequestSniffableWebView";
pub const OPEN_EVENT: &str = "bridge:Open";
pub const SNIFFING_COMPLETE_EVENT: &str = "bridge:SniffingComplete";

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. Re-exported so
/// integration tests can drift-guard against a config rename; not
/// referenced at runtime in this crate (the sniffer opens as a peer
/// top-level `WebviewWindow`, not a child of the main window).
pub const MAIN_WINDOW_LABEL: &str = "main";
