//! The `WebViewSource` wire union and its validation — moved (and de-Tauri'd)
//! from `browser-sniffer-tauri-rust`'s `model/web_view_source.rs`. Mirrors the
//! TS schema in `collector-fundamentals/src/model/web-view-source.ts`; the
//! validation is defense-in-depth alongside the client-side schema check, and
//! under HTTP its failures are answerable 400s rather than warn-and-drops.

use serde::Deserialize;
use utoipa::ToSchema;

/// Wire shape of the `WebViewSource` tagged union (mirrors the TS
/// `WebViewSource.AnySchema` in `browser-sniffer-core`). The `Uri` variant
/// carries an `http(s)://`-only URL (both schemes, so a FHIR server reachable
/// only over http — e.g. a local dev HAPI instance — can still be sniffed).
/// `Html` is decoded but rejected by [`resolve_source`] — the variant exists
/// so the wire union matches the TS side (and the failure is an answerable
/// 400), not because the host can present raw HTML today.
#[derive(Debug, PartialEq, Deserialize, ToSchema)]
#[serde(tag = "_tag")]
pub enum WebViewSourcePayload {
    Uri(UriSource),
    Html(HtmlSource),
}

/// The `Uri` variant's body. `method` / `headers` / `body` are part of the TS
/// wire shape (a legacy of the React Native `<WebView source>` prop) but
/// unused by this host — declared so the OpenAPI schema matches the client's,
/// decoded-and-ignored at runtime exactly as the old bridge decoder tolerated
/// them.
#[derive(Debug, PartialEq, Deserialize, ToSchema)]
pub struct UriSource {
    pub uri: String,
    pub method: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
}

/// The `Html` variant's body — declared so the wire union matches the TS
/// side; [`resolve_source`] rejects it as unsupported.
#[derive(Debug, PartialEq, Deserialize, ToSchema)]
pub struct HtmlSource {
    pub html: String,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
}

/// Why a `WebViewSource` was rejected. Renders as a 400 `InvalidSource` (see
/// `http::errors`) — a real acknowledgement where the bridge could only
/// warn-and-drop.
#[derive(Debug)]
pub enum SourceResolveError {
    NonHttpUri(String),
    InvalidUri(String),
    HtmlNotSupported,
}

impl std::fmt::Display for SourceResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NonHttpUri(uri) => {
                write!(f, "WebViewSource.Uri must be http(s):// (got: {uri})")
            }
            Self::InvalidUri(uri) => write!(f, "WebViewSource.Uri could not be parsed: {uri}"),
            Self::HtmlNotSupported => {
                write!(f, "WebViewSource.Html is not supported by this host")
            }
        }
    }
}

/// Validate a `WebViewSource` down to the `http(s)://` URL string the
/// [`SnifferWebviewHandle`](super::SnifferWebviewHandle) navigates to.
///
/// # Errors
///
/// [`SourceResolveError::NonHttpUri`] / [`InvalidUri`](SourceResolveError::InvalidUri)
/// for a URI that isn't a parseable `http(s)://` URL;
/// [`SourceResolveError::HtmlNotSupported`] for the `Html` variant.
pub fn resolve_source(source: WebViewSourcePayload) -> Result<String, SourceResolveError> {
    match source {
        WebViewSourcePayload::Uri(UriSource { uri, .. }) => {
            if !uri.starts_with("https://") && !uri.starts_with("http://") {
                return Err(SourceResolveError::NonHttpUri(uri));
            }
            let parsed = url::Url::parse(&uri).map_err(|_| SourceResolveError::InvalidUri(uri))?;
            Ok(parsed.into())
        }
        WebViewSourcePayload::Html(_) => Err(SourceResolveError::HtmlNotSupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri_source(uri: &str) -> WebViewSourcePayload {
        WebViewSourcePayload::Uri(UriSource {
            uri: uri.to_string(),
            method: None,
            headers: None,
            body: None,
        })
    }

    #[test]
    fn resolve_source_rejects_non_http_uri() {
        let error = resolve_source(uri_source("ftp://example.test/")).expect_err("rejection");
        assert!(
            matches!(error, SourceResolveError::NonHttpUri(uri) if uri == "ftp://example.test/"),
        );
    }

    #[test]
    fn resolve_source_accepts_https_uri() {
        assert_eq!(
            resolve_source(uri_source("https://example.test/page")).expect("expected success"),
            "https://example.test/page",
        );
    }

    #[test]
    fn resolve_source_accepts_http_uri() {
        // Plain http is accepted so a FHIR server reachable only over http
        // (e.g. a local dev HAPI instance) can still be sniffed — mirrors the
        // TS-side `HttpUriString` schema.
        assert_eq!(
            resolve_source(uri_source("http://localhost:8080/fhir/Patient/1"))
                .expect("expected success"),
            "http://localhost:8080/fhir/Patient/1",
        );
    }

    #[test]
    fn resolve_source_reports_html_as_unsupported() {
        let html = WebViewSourcePayload::Html(HtmlSource {
            html: "<html></html>".to_string(),
            base_url: None,
        });
        let error = resolve_source(html).expect_err("expected rejection");
        assert!(matches!(error, SourceResolveError::HtmlNotSupported));
    }

    #[test]
    fn web_view_source_decodes_the_ts_html_shapes() {
        // The wire carries `html` and (optionally) `baseUrl` — both shapes
        // land on `WebViewSourcePayload::Html`.
        let with_base =
            r#"{"_tag":"Html","html":"<html></html>","baseUrl":"https://issuer.test/"}"#;
        let without_base = r#"{"_tag":"Html","html":"<html></html>"}"#;
        let decoded_with: WebViewSourcePayload = serde_json::from_str(with_base).expect("decode");
        let decoded_without: WebViewSourcePayload =
            serde_json::from_str(without_base).expect("decode");
        assert_eq!(
            decoded_with,
            WebViewSourcePayload::Html(HtmlSource {
                html: "<html></html>".to_string(),
                base_url: Some("https://issuer.test/".to_string()),
            }),
        );
        assert_eq!(
            decoded_without,
            WebViewSourcePayload::Html(HtmlSource {
                html: "<html></html>".to_string(),
                base_url: None,
            }),
        );
    }

    #[test]
    fn uri_source_decodes_the_ts_side_extras() {
        // The TS `UriSchema` optionally carries method/headers/body; the host
        // only navigates, so they're decoded-and-ignored.
        let json =
            r#"{"_tag":"Uri","uri":"https://example.test/","method":"GET","headers":{"a":"b"}}"#;
        let decoded: WebViewSourcePayload = serde_json::from_str(json).expect("decode");
        assert_eq!(
            decoded,
            WebViewSourcePayload::Uri(UriSource {
                uri: "https://example.test/".to_string(),
                method: Some("GET".to_string()),
                headers: Some(std::collections::HashMap::from([(
                    "a".to_string(),
                    "b".to_string()
                )])),
                body: None,
            }),
        );
    }
}
