//! Wire shapes shared between the Rust command layer and the native (Swift /
//! Kotlin) plugin. `OpenRequest` is what crosses `run_mobile_plugin("open", …)`;
//! `OpenResponse` is what the native side resolves back. Field names are
//! `camelCase` on the wire to match the Swift `Decodable` / Kotlin `@InvokeArg`
//! sides.

use serde::{Deserialize, Serialize};

/// Arguments for opening the native webview popup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// The external URL to load. Any `http(s)://` origin is accepted.
    pub url: String,
    /// JavaScript injected at **document start** into every page on **any**
    /// origin (the caller owns this — e.g. browser-sniffer's bundled
    /// `installSniffer` IIFE). `None` injects nothing; the plugin itself is
    /// content-agnostic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_script: Option<String>,
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

    /// With no init script, `OpenRequest` rides the wire as `{ "url": … }` —
    /// `init_script` is omitted (not `null`) so the native `Decodable`/
    /// `@InvokeArg` optional decodes cleanly. The Swift/Kotlin `OpenArgs` pin
    /// the same keys; drift here would silently break decoding on-device.
    #[test]
    fn open_request_omits_absent_init_script() {
        let json = serde_json::to_string(&OpenRequest {
            url: "https://example.test/x".to_owned(),
            init_script: None,
        })
        .expect("serialize");
        assert_eq!(json, r#"{"url":"https://example.test/x"}"#);
    }

    /// The injected script rides under the camelCase `initScript` key.
    #[test]
    fn open_request_serializes_init_script_camel_case() {
        let json = serde_json::to_string(&OpenRequest {
            url: "https://example.test/x".to_owned(),
            init_script: Some("console.log(1)".to_owned()),
        })
        .expect("serialize");
        assert_eq!(
            json,
            r#"{"url":"https://example.test/x","initScript":"console.log(1)"}"#
        );
    }

    /// Round-trips so the same struct the command builds is the one the native
    /// side decodes.
    #[test]
    fn open_request_round_trips() {
        let original = OpenRequest {
            url: "http://localhost:8080/p".to_owned(),
            init_script: Some("void 0".to_owned()),
        };
        let decoded: OpenRequest =
            serde_json::from_str(&serde_json::to_string(&original).expect("ser")).expect("de");
        assert_eq!(decoded, original);
    }

    /// `OpenResponse` decodes the native-side `{ "opened": true }` payload.
    #[test]
    fn open_response_decodes_opened_flag() {
        let decoded: OpenResponse = serde_json::from_str(r#"{"opened":true}"#).expect("de");
        assert!(decoded.opened);
    }
}
