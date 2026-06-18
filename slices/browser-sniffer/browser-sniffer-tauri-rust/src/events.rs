//! Sniffer-specific tag literals dispatched on the multiplexed bridge
//! channel. The channel name (`BRIDGE_EVENT`), envelope shape, and the
//! single-channel/FIFO rationale live in [`shared_structures_rust::bridge`];
//! this module only owns the per-crate tag literals and window labels.

/// Web→host tag literals this crate dispatches on.
pub const REQUEST_SNIFFABLE_WEBVIEW: &str = "RequestSniffableWebView";
pub const OPEN: &str = "Open";
pub const SNIFFING_COMPLETE: &str = "SniffingComplete";

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. Re-exported so
/// integration tests can drift-guard against a config rename; not
/// referenced at runtime in this crate (the sniffer opens as a peer
/// top-level `WebviewWindow`, not a child of the main window).
pub const MAIN_WINDOW_LABEL: &str = "main";
