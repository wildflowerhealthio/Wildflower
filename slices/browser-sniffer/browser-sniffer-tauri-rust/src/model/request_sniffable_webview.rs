use serde::Deserialize;

/// Wire shape of `CollectorBridge.webToHost.RequestSniffableWebView`,
/// pinned by `slices/collector/collector-fundamentals/src/bridge.ts`.
///
/// It carries **no starting page**: the host always mounts the sniffer on
/// `about:blank` and the plan navigates from there with a leading `Open` step.
/// The optional `linkedSpan` field is decoded-and-dropped (serde ignores
/// fields the struct does not name) — the per-page span linkage is the React
/// SPA's responsibility once sniffer events flow back through
/// `CollectorBridge.hostToWeb`. The struct is retained (rather than skipping the
/// decode) so a malformed payload still surfaces as a decode mismatch here.
#[derive(Debug, PartialEq, Deserialize)]
pub(crate) struct RequestSniffableWebViewPayload {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_without_a_source() {
        // The mount request carries no starting page; a bare tag and an
        // optional linkedSpan both decode (extra fields are ignored).
        let bare = r#"{"_tag":"RequestSniffableWebView"}"#;
        let with_span =
            r#"{"_tag":"RequestSniffableWebView","linkedSpan":{"traceId":"a","spanId":"b"}}"#;
        serde_json::from_str::<RequestSniffableWebViewPayload>(bare).expect("decode bare");
        serde_json::from_str::<RequestSniffableWebViewPayload>(with_span)
            .expect("decode with linkedSpan");
    }
}
