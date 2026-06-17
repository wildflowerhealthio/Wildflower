use serde::Deserialize;
use tauri::WebviewUrl;

/// Wire shape of the `WebViewSource` tagged union from
/// `slices/collector/collector-fundamentals/src/model/web-view-source.ts`.
/// The `Uri` variant carries an `https://`-only URL; we validate that
/// invariant at decode time as defense-in-depth alongside the SPA-side
/// schema check. `Html` is decoded body-less (a `serde::de::IgnoredAny`
/// drains the field without allocating) — the variant exists so wire-shape
/// drift surfaces as a decode mismatch on the Rust side, not because the
/// host can do anything with the payload today.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "_tag")]
pub(crate) enum WebViewSourcePayload {
    Uri(UriSource),
    Html,
}

#[derive(Debug, PartialEq, Deserialize)]
pub(crate) struct UriSource {
    pub(crate) uri: String,
}

/// Errors raised while resolving a `WebViewSource` to a `WebviewUrl`.
/// Surfaces back to the caller via the listener's warn-and-drop path —
/// the SPA receives no acknowledgement (matching the
/// `effect-messaging-tauri` warn-and-drop convention for malformed
/// events) but the failure lands in the host log.
#[derive(Debug)]
pub(crate) enum SourceResolveError {
    NonHttpsUri(String),
    InvalidUri(String),
    HtmlNotSupported,
}

impl std::fmt::Display for SourceResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NonHttpsUri(uri) => write!(
                f,
                "WebViewSource.Uri must be https:// (got: {uri}); the SPA-side schema should have \
                 rejected this — investigate drift"
            ),
            Self::InvalidUri(uri) => write!(f, "WebViewSource.Uri could not be parsed: {uri}"),
            Self::HtmlNotSupported => write!(
                f,
                "WebViewSource.Html is not yet supported in Tauri; see the open question in the \
                 implementation plan"
            ),
        }
    }
}

pub(crate) fn resolve_source(
    source: WebViewSourcePayload,
) -> Result<WebviewUrl, SourceResolveError> {
    match source {
        WebViewSourcePayload::Uri(UriSource { uri }) => {
            if !uri.starts_with("https://") {
                return Err(SourceResolveError::NonHttpsUri(uri));
            }
            let parsed = url::Url::parse(&uri).map_err(|_| SourceResolveError::InvalidUri(uri))?;
            Ok(WebviewUrl::External(parsed))
        }
        WebViewSourcePayload::Html => Err(SourceResolveError::HtmlNotSupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_source_rejects_non_https_uri() {
        let source = WebViewSourcePayload::Uri(UriSource {
            uri: "http://example.test/".to_string(),
        });
        let error = resolve_source(source).expect_err("expected rejection");
        assert!(
            matches!(error, SourceResolveError::NonHttpsUri(uri) if uri == "http://example.test/"),
        );
    }

    #[test]
    fn resolve_source_accepts_https_uri() {
        let source = WebViewSourcePayload::Uri(UriSource {
            uri: "https://example.test/page".to_string(),
        });
        let resolved = resolve_source(source).expect("expected success");
        match resolved {
            WebviewUrl::External(url) => {
                assert_eq!(url.as_str(), "https://example.test/page");
            }
            _ => panic!("expected WebviewUrl::External"),
        }
    }

    #[test]
    fn resolve_source_reports_html_as_unsupported() {
        let error = resolve_source(WebViewSourcePayload::Html).expect_err("expected rejection");
        assert!(matches!(error, SourceResolveError::HtmlNotSupported));
    }

    #[test]
    fn web_view_source_decodes_html_without_consuming_body() {
        // The wire still carries `html` and (optionally) `baseUrl`; we
        // decode-and-drop them. Both shapes — with and without baseUrl —
        // must land on `WebViewSourcePayload::Html` without an allocation
        // for the body.
        let with_base =
            r#"{"_tag":"Html","html":"<html></html>","baseUrl":"https://issuer.test/"}"#;
        let without_base = r#"{"_tag":"Html","html":"<html></html>"}"#;
        let decoded_with: WebViewSourcePayload = serde_json::from_str(with_base).expect("decode");
        let decoded_without: WebViewSourcePayload =
            serde_json::from_str(without_base).expect("decode");
        assert_eq!(decoded_with, WebViewSourcePayload::Html);
        assert_eq!(decoded_without, WebViewSourcePayload::Html);
    }
}
