use serde::Deserialize;

use super::web_view_source::WebViewSourcePayload;

/// Wire shape of `CollectorBridge.webToHost.RequestSniffableWebView`,
/// pinned by `slices/collector/collector-fundamentals/src/bridge.ts`.
/// The `linkedSpan` field is decoded-and-dropped at this layer — the
/// per-page span linkage is the React SPA's responsibility once
/// sniffer events flow back through `CollectorBridge.hostToWeb`.
#[derive(Debug, PartialEq, Deserialize)]
pub(crate) struct RequestSniffableWebViewPayload {
    pub(crate) source: WebViewSourcePayload,
}

#[cfg(test)]
mod tests {
    use super::super::web_view_source::UriSource;
    use super::*;

    #[test]
    fn decodes_uri_source() {
        let payload = r#"{"_tag":"RequestSniffableWebView","source":{"_tag":"Uri","uri":"https://example.test/"}}"#;
        let decoded: RequestSniffableWebViewPayload =
            serde_json::from_str(payload).expect("decode");
        assert_eq!(
            decoded,
            RequestSniffableWebViewPayload {
                source: WebViewSourcePayload::Uri(UriSource {
                    uri: "https://example.test/".to_string(),
                }),
            }
        );
    }
}
