//! The apps bridge wire types shared with the embedded SPA.
//!
//! The apps SPA asks the host to bring a tunnel up (so an app that needs a
//! publicly-reachable origin can launch) via the web→host `RequestTunnel`
//! message; the host replies with [`AppsHostToWeb::TunnelStarted`] carrying the
//! verified public origin, or [`AppsHostToWeb::TunnelFailed`] with a reason.
//!
//! Payload shapes are pinned by the TS schema in
//! `slices/apps/apps-core/src/bridge.ts` — the web side validates inbound
//! payloads against that schema, so the serde representation here must stay
//! byte-compatible. The inbound `RequestTunnel` envelope (`{"_tag":
//! "RequestTunnel"}`) carries no fields, so the host decodes it by tag alone.

use serde::{Deserialize, Serialize};

/// Host→web messages on the apps bridge — the outcome the SPA waits on before
/// redirecting to a tunnel-requiring app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum AppsHostToWeb {
    /// The host brought the tunnel up; `origin` is the verified public origin
    /// (`https://{host}`) the SPA should redirect to.
    /// Wire: `{"_tag":"TunnelStarted","origin":"https://host"}`.
    TunnelStarted { origin: String },
    /// The host could not bring the tunnel up; `reason` is a short
    /// human-readable description suitable for surfacing inline.
    /// Wire: `{"_tag":"TunnelFailed","reason":"..."}`.
    TunnelFailed { reason: String },
}

/// The web→host `RequestTunnel` tag literal, pinned against the TS schema's
/// `Schema.TaggedStruct('RequestTunnel', {})` in `apps-core/src/bridge.ts`.
pub const REQUEST_TUNNEL_TAG: &str = "RequestTunnel";

/// The web→host `RequestSandboxedWebView` tag literal, pinned against the TS
/// schema's `Schema.TaggedStruct('RequestSandboxedWebView', { url })` in
/// `apps-core/src/bridge.ts`. The host (wildflower-tauri) decodes the `url`
/// field and opens it in the shared sandboxed webview.
pub const REQUEST_SANDBOXED_WEBVIEW_TAG: &str = "RequestSandboxedWebView";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_started_serializes_to_the_pinned_wire_format() {
        let message = AppsHostToWeb::TunnelStarted {
            origin: "https://dev1.example.com".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"TunnelStarted","origin":"https://dev1.example.com"}"#
        );
    }

    #[test]
    fn tunnel_failed_serializes_to_the_pinned_wire_format() {
        let message = AppsHostToWeb::TunnelFailed {
            reason: "tunnel not available".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"TunnelFailed","reason":"tunnel not available"}"#
        );
    }

    #[test]
    fn host_to_web_round_trips() {
        for message in [
            AppsHostToWeb::TunnelStarted {
                origin: "https://h".to_string(),
            },
            AppsHostToWeb::TunnelFailed {
                reason: "nope".to_string(),
            },
        ] {
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: AppsHostToWeb = serde_json::from_str(&encoded).expect("deserialize");
            assert_eq!(decoded, message);
        }
    }

    #[test]
    fn request_tunnel_tag_matches_the_ts_schema() {
        // The inbound envelope is `{"_tag":"RequestTunnel"}` (no fields); the
        // host routes on this literal.
        assert_eq!(REQUEST_TUNNEL_TAG, "RequestTunnel");
    }

    #[test]
    fn request_sandboxed_webview_tag_matches_the_ts_schema() {
        // The inbound envelope is
        // `{"_tag":"RequestSandboxedWebView","url":"..."}`; the host routes on
        // this literal and reads the `url` field.
        assert_eq!(REQUEST_SANDBOXED_WEBVIEW_TAG, "RequestSandboxedWebView");
    }
}
