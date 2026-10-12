//! `http(s)`-only URL parsing shared by both plugin backends.
//!
//! The in-app browser loads arbitrary external pages, so the scheme is
//! constrained to `http` / `https` — `data:`, `file:`, `javascript:` etc. must
//! never reach it. Both backends' `open` validate through this one function.
//!
//! Mirrors `tauri-plugin-native-webview`'s `url_scheme::parse_http_url`. That
//! module is private to its crate and also admits `about:blank` (a webview
//! placeholder the in-app browser has no use for), and each plugin stays
//! self-contained, so this keeps its own copy of the one rule.

use url::Url;

/// Parse `uri` into a [`Url`], rejecting any non-`http(s)` scheme.
///
/// # Errors
///
/// Returns [`crate::Error::InvalidUrl`] when `uri` does not parse, or parses to
/// a scheme other than `http` / `https`.
pub(crate) fn parse_http_url(uri: &str) -> crate::Result<Url> {
    let parsed = Url::parse(uri)
        .map_err(|error| crate::Error::InvalidUrl(format!("{uri:?} doesn't parse: {error}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(crate::Error::InvalidUrl(format!(
            "{uri:?} must be http(s)://, not {other:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        for uri in [
            "https://example.test/session/bootstrap?ticket=abc",
            "http://localhost:8080/launcher/",
        ] {
            let parsed = parse_http_url(uri).expect("should parse");
            assert_eq!(parsed.as_str(), uri);
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        for uri in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "about:blank",
            "ftp://example.test/",
        ] {
            assert!(
                matches!(parse_http_url(uri), Err(crate::Error::InvalidUrl(_))),
                "{uri} should have been rejected as an invalid URL",
            );
        }
    }

    #[test]
    fn rejects_unparseable() {
        assert!(matches!(
            parse_http_url("not a url"),
            Err(crate::Error::InvalidUrl(_))
        ));
    }
}
