use serde::Deserialize;
use tauri::WebviewUrl;

/// Wire shape of `Open`'s `source` in `RecorderBridge`
/// (`apps/host/recorder/recorder-core-js/src/bridge.ts`): a tagged `Uri`
/// carrying an `http(s)://`-only URL. We validate that invariant at decode
/// time as defense-in-depth alongside the page-side schema check (which
/// likewise accepts both schemes so a server reachable only over http — e.g.
/// a local dev HAPI instance — can still be sniffed). Pinned by
/// `recorder-wire-golden.json`'s `webToHost.Open` source as well as by
/// `RecorderBridge`.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "_tag")]
pub(crate) enum WebViewSourcePayload {
    Uri(UriSource),
}

#[derive(Debug, PartialEq, Deserialize)]
pub(crate) struct UriSource {
    pub(crate) uri: String,
}

/// Errors raised while resolving a `WebViewSource` to a `WebviewUrl`.
/// Surfaces back to the caller via the listener's warn-and-drop path —
/// the SPA receives no acknowledgement (matching the
/// `effect-messaging-tauri-js` warn-and-drop convention for malformed
/// events) but the failure lands in the host log.
#[derive(Debug)]
pub(crate) enum SourceResolveError {
    NonHttpUri(String),
    InvalidUri(String),
}

impl std::fmt::Display for SourceResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NonHttpUri(uri) => write!(
                f,
                "WebViewSource.Uri must be http(s):// (got: {uri}); the SPA-side schema should \
                 have rejected this — investigate drift"
            ),
            Self::InvalidUri(uri) => write!(f, "WebViewSource.Uri could not be parsed: {uri}"),
        }
    }
}

pub(crate) fn resolve_source(
    source: WebViewSourcePayload,
) -> Result<WebviewUrl, SourceResolveError> {
    match source {
        WebViewSourcePayload::Uri(UriSource { uri }) => {
            if !uri.starts_with("https://") && !uri.starts_with("http://") {
                return Err(SourceResolveError::NonHttpUri(uri));
            }
            let parsed = url::Url::parse(&uri).map_err(|_| SourceResolveError::InvalidUri(uri))?;
            Ok(WebviewUrl::External(parsed))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_source_rejects_non_http_uri() {
        let source = WebViewSourcePayload::Uri(UriSource {
            uri: "ftp://example.test/".to_string(),
        });
        let error = resolve_source(source).expect_err("expected rejection");
        assert!(
            matches!(error, SourceResolveError::NonHttpUri(uri) if uri == "ftp://example.test/"),
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
    fn resolve_source_accepts_http_uri() {
        // Plain http is accepted so a FHIR server reachable only over http
        // (e.g. a local dev HAPI instance) can still be sniffed — mirrors
        // the page-side `HttpUrl` schema.
        let source = WebViewSourcePayload::Uri(UriSource {
            uri: "http://localhost:8080/fhir/Patient/1".to_string(),
        });
        let resolved = resolve_source(source).expect("expected success");
        match resolved {
            WebviewUrl::External(url) => {
                assert_eq!(url.as_str(), "http://localhost:8080/fhir/Patient/1");
            }
            _ => panic!("expected WebviewUrl::External"),
        }
    }
}
