//! Bridge event constants and the multiplexed envelope shape. Must
//! match the TS side in
//! `global/effect-messaging/effect-messaging-tauri/src/event-names.ts`.
//! Drift between Rust and TS is caught by
//! `bridge_event_and_tags_match_the_ts_convention` in `lib.rs`.
//!
//! Every web↔host message rides the single `BRIDGE_EVENT` Tauri event;
//! the discriminator is the `_tag` field on the JSON payload, which
//! every bridge message already carries. Per-tag listeners would let
//! Tauri re-order events across tags — Tauri only guarantees FIFO
//! within a single event name — so the multiplexed channel is what
//! pins strict ordering for the sniffer's chunked page-content stream.

use serde::Deserialize;

pub const BRIDGE_EVENT: &str = "bridge";

/// Web→host tag literals this crate dispatches on. Each handler's log
/// message embeds its tag for diagnostic continuity with the old
/// per-tag scheme.
pub const REQUEST_SNIFFABLE_WEBVIEW: &str = "RequestSniffableWebView";
pub const OPEN: &str = "Open";
pub const SNIFFING_COMPLETE: &str = "SniffingComplete";

/// Wire shape of the bridge envelope's `_tag` discriminator. Used to
/// peek the tag without committing to a specific message struct, so
/// the listener can route by tag and skip payloads it does not react
/// to.
#[derive(Debug, Deserialize)]
pub(crate) struct BridgeEnvelope {
    #[serde(rename = "_tag")]
    pub(crate) tag: String,
}

/// Window label assigned to the main React SPA webview by
/// `apps/wildflower-tauri/src-tauri/tauri.conf.json`. Re-exported so
/// integration tests can drift-guard against a config rename; not
/// referenced at runtime in this crate (the sniffer opens as a peer
/// top-level `WebviewWindow`, not a child of the main window).
pub const MAIN_WINDOW_LABEL: &str = "main";
