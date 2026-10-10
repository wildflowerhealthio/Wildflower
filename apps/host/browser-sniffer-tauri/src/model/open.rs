use serde::Deserialize;

use super::web_view_source::WebViewSourcePayload;

/// Wire shape of `CollectorBridge.webToHost.Open`: the source the sniffer
/// webview should load. Its own struct (rather than a bare
/// `WebViewSourcePayload`) so future envelope fields — e.g. a
/// `clearStateFirst` flag — have somewhere to land.
#[derive(Debug, PartialEq, Deserialize)]
pub(crate) struct OpenPayload {
    pub(crate) source: WebViewSourcePayload,
}

#[cfg(test)]
mod tests {
    use super::super::web_view_source::UriSource;
    use super::*;

    #[test]
    fn decodes_uri_source() {
        let payload =
            r#"{"_tag":"Open","source":{"_tag":"Uri","uri":"https://example.test/next"}}"#;
        let decoded: OpenPayload = serde_json::from_str(payload).expect("decode");
        assert_eq!(
            decoded,
            OpenPayload {
                source: WebViewSourcePayload::Uri(UriSource {
                    uri: "https://example.test/next".to_string(),
                }),
            }
        );
    }
}
