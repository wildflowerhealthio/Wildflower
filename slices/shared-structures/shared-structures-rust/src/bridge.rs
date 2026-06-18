//! Cross-crate constants and envelope shape for the multiplexed Tauri
//! bridge channel. Both the wildflower-tauri host crate and the
//! browser-sniffer host crate (and any future Rust crate that listens
//! on the bridge) must agree on the channel name and the discriminator
//! field, otherwise tag routing silently breaks with no compile error.
//! Hoisting them here means there is exactly one source of truth.
//!
//! The TS side pins the same `BRIDGE_EVENT` literal in
//! `global/effect-messaging/effect-messaging-tauri/src/event-names.ts`;
//! see [`tests::bridge_event_matches_the_ts_convention`] for the drift
//! guard.

use serde::Deserialize;

/// Single multiplexed bridge channel name. Every web↔host message
/// rides this one Tauri event; the discriminator is the `_tag` field
/// on the JSON payload, which every bridge message already carries.
/// Per-tag channels were retired because Tauri only guarantees FIFO
/// within a single event name — cross-tag ordering broke streaming
/// (notably the sniffer's chunked page-content stream).
pub const BRIDGE_EVENT: &str = "bridge";

/// Wire shape of the bridge envelope's `_tag` discriminator. Used to
/// peek the tag without committing to a specific message struct, so a
/// listener can route by tag and skip payloads it does not react to.
#[derive(Debug, Deserialize)]
pub struct BridgeEnvelope {
    #[serde(rename = "_tag")]
    pub tag: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard: the TS side pins the same literal in
    /// `effect-messaging-tauri/src/event-names.test.ts`. Any Rust
    /// crate that listens on this channel inherits this guarantee.
    #[test]
    fn bridge_event_matches_the_ts_convention() {
        assert_eq!(BRIDGE_EVENT, "bridge");
    }

    /// The envelope deserializer ignores fields beyond `_tag` so the
    /// same peek decodes any concrete payload shape.
    #[test]
    fn envelope_decodes_the_tag_and_ignores_other_fields() {
        let decoded: BridgeEnvelope =
            serde_json::from_str(r#"{"_tag":"AuthTokenIssued","extra":42}"#).expect("decode");
        assert_eq!(decoded.tag, "AuthTokenIssued");
    }
}
