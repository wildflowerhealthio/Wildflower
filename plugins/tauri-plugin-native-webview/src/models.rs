//! Wire shapes shared between the Rust command layer and the native (Swift)
//! plugin. `OpenRequest` is what crosses `run_mobile_plugin("open", …)`;
//! `OpenResponse` is what the Swift side resolves back. Field names are
//! `camelCase` on the wire to match the Swift `Decodable`/`JSObject` side.

use serde::{Deserialize, Serialize};

/// Arguments for opening the native webview popup at `url`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// The external URL to load. Any `http(s)://` origin is accepted; the
    /// injected document-start script runs regardless of origin.
    pub url: String,
}

/// Result of an `open` invocation. `opened` is `true` once the native popup
/// has been presented (the load itself proceeds asynchronously).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenResponse {
    /// Whether the native popup was presented.
    pub opened: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `OpenRequest` rides the wire as `{ "url": … }` (camelCase). The Swift
    /// `OpenArgs` decoder pins the same key, so a drift here would silently
    /// break argument decoding on the device with no Rust compile error.
    #[test]
    fn open_request_serializes_url_key() {
        let json = serde_json::to_string(&OpenRequest {
            url: "https://example.test/x".to_owned(),
        })
        .expect("serialize");
        assert_eq!(json, r#"{"url":"https://example.test/x"}"#);
    }

    /// Round-trips so the same struct the command builds is the one the Swift
    /// side will decode.
    #[test]
    fn open_request_round_trips() {
        let original = OpenRequest {
            url: "http://localhost:8080/p".to_owned(),
        };
        let decoded: OpenRequest =
            serde_json::from_str(&serde_json::to_string(&original).expect("ser")).expect("de");
        assert_eq!(decoded, original);
    }

    /// `OpenResponse` decodes the Swift-side `{ "opened": true }` payload.
    #[test]
    fn open_response_decodes_opened_flag() {
        let decoded: OpenResponse = serde_json::from_str(r#"{"opened":true}"#).expect("de");
        assert!(decoded.opened);
    }
}
