//! `http(s)`-only URL parsing shared by both plugin backends.
//!
//! The native webview loads arbitrary external pages, so the scheme must be constrained
//! to `http` / `https` — `data:`, `file:`, `javascript:` etc. must never reach
//! the webview. Both the desktop (`desktop::NativeWebview::open`) and mobile
//! (`mobile::NativeWebview::open`) entry points validate through this single
//! function, so the scheme rule lives in exactly one place and the parsed
//! [`Url`] is threaded onward instead of being re-derived per call site.
//!
//! Mirrors `shared_structures_tauri_rust::sandboxed_webview::resolve_http_url`
//! in intent; kept local here so this self-contained plugin doesn't take a
//! dependency on an app-level slice adapter (the layering points the other way).

use url::Url;

/// Construct the target-appropriate [`crate::Error`] variant ([`Error::Internal`](crate::Error::Internal)
/// on desktop, [`Error::PluginInvoke`](crate::Error::PluginInvoke) on mobile), which are themselves cfg-gated.
#[cfg(desktop)]
fn scheme_error(message: String) -> crate::Error {
    crate::Error::Internal(message)
}

#[cfg(mobile)]
fn scheme_error(message: String) -> crate::Error {
    crate::Error::PluginInvoke(message)
}

/// Parse `uri` into a [`Url`], rejecting any non-`http(s)` scheme.
///
/// # Errors
///
/// Returns [`crate::Error`] when `uri` does not parse, or parses to a scheme
/// other than `http` / `https`.
pub(crate) fn parse_http_url(uri: &str) -> crate::Result<Url> {
    let parsed =
        Url::parse(uri).map_err(|error| scheme_error(format!("invalid URL {uri}: {error}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(scheme_error(format!(
            "native-webview URL must be http(s):// (got scheme {other:?} in {uri})"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        for uri in [
            "https://example.test/page",
            "http://localhost:8080/fhir/Patient/1",
        ] {
            let parsed = parse_http_url(uri).expect("should parse");
            assert_eq!(parsed.as_str(), uri);
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        for uri in [
            "ftp://example.test/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
        ] {
            assert!(
                parse_http_url(uri).is_err(),
                "{uri} should have been rejected",
            );
        }
    }

    #[test]
    fn rejects_unparseable() {
        assert!(parse_http_url("not a url").is_err());
    }
}
