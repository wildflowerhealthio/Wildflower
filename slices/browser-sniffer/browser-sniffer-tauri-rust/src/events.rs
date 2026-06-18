//! Sniffer-specific tag literals dispatched on the multiplexed bridge
//! channel. The channel name and envelope shape are shared with every
//! other Rust bridge listener via
//! [`shared_structures_rust::bridge`] — this module only owns the
//! per-crate tag literals and window labels.
//!
//! Every web↔host message rides the single `BRIDGE_EVENT` Tauri event;
//! the discriminator is the `_tag` field on the JSON payload, which
//! every bridge message already carries. Per-tag listeners would let
//! Tauri re-order events across tags — Tauri only guarantees FIFO
//! within a single event name — so the multiplexed channel is what
//! pins strict ordering for the sniffer's chunked page-content stream.

/// Web→host tag literals this crate dispatches on. Each handler's log
/// message embeds its tag for diagnostic continuity with the old
/// per-tag scheme.
pub const REQUEST_SNIFFABLE_WEBVIEW: &str = "RequestSniffableWebView";
pub const OPEN: &str = "Open";
pub const SNIFFING_COMPLETE: &str = "SniffingComplete";

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. Re-exported so
/// integration tests can drift-guard against a config rename; not
/// referenced at runtime in this crate (the sniffer opens as a peer
/// top-level `WebviewWindow`, not a child of the main window).
pub const MAIN_WINDOW_LABEL: &str = "main";
