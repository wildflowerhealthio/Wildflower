//! What the authorization server's browser pages share: the
//! [wait page](super::wait_page) and the [authorization
//! pages](super::authorization_pages) (the consent card, the limited page, the
//! device page and the pairing page). Each is served on the server's origin,
//! under the same security headers. The pages for one pending request (the
//! wait page, the consent card, the limited page) are reached at a path beside
//! `/oauth/authorize` that names the request.

use axum::http::header::{self, HeaderName};
use axum::http::HeaderValue;
use url::form_urlencoded;

/// The `form-action` sources of a page that submits no form.
pub(super) const NO_FORM_TARGETS: &str = "'none'";

/// The `Content-Security-Policy` of a page whose forms may submit to, and
/// follow redirects to, `form_targets` (a `form-action` source list,
/// [`NO_FORM_TARGETS`] for none). Everything a page loads (its scripts,
/// stylesheets and fonts) comes from this origin, it can only talk back to it,
/// and nothing may frame it. The top-level navigation to the client's redirect
/// is not a fetch, so `connect-src` doesn't constrain it. A router builds it
/// once and hands it to [`page_security_headers`] for each request.
///
/// # Panics
///
/// When `form_targets` holds a byte a header value can't, which a source list
/// of keywords and origins never does.
pub(super) fn content_security_policy(form_targets: &str) -> HeaderValue {
    HeaderValue::try_from(format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; \
         connect-src 'self'; base-uri 'none'; form-action {form_targets}; \
         frame-ancestors 'none'"
    ))
    .expect("a source list of keywords and origins is a valid header value")
}

/// The headers every file of a page carries: its `content_type`, its
/// `content_security_policy` (built by [`content_security_policy`]), no
/// `Referer` on anything it loads from or leaves for another origin, and no
/// sniffing a type other than the one declared. The referrer policy is
/// `same-origin`, not `no-referrer`: under `no-referrer` a browser sends a form
/// `POST` with `Origin: null`, which the host's cookie→bearer layer refuses, so
/// the pages' Sign out would fail.
pub(super) fn page_security_headers(
    content_type: &'static str,
    content_security_policy: &HeaderValue,
) -> [(HeaderName, HeaderValue); 4] {
    [
        (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
        (
            header::CONTENT_SECURITY_POLICY,
            content_security_policy.clone(),
        ),
        (
            header::REFERRER_POLICY,
            HeaderValue::from_static("same-origin"),
        ),
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
    ]
}

/// The `Location` of `page` for pending request `request_id`: relative, so the
/// browser resolves it against the `…/oauth/authorize` it just requested.
pub(super) fn request_page_location(request_id: &str, page: &str) -> String {
    let encoded_request_id = form_urlencoded::byte_serialize(request_id.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    format!("authorize/{encoded_request_id}/{page}")
}

#[cfg(test)]
mod tests {
    use url::Url;

    use super::request_page_location;

    /// Resolved against an authorize URL with a query, a request page's
    /// location lands at `/oauth/authorize/{id}/{page}`.
    #[test]
    fn a_request_page_resolves_beside_the_authorize_endpoint() {
        let authorize = Url::parse("https://ruth.wildflowerhealth.example/oauth/authorize?x=1")
            .expect("valid url");
        for page in ["wait", "consent"] {
            let resolved = authorize
                .join(&request_page_location("req-1", page))
                .expect("resolves");
            assert_eq!(
                resolved.as_str(),
                format!("https://ruth.wildflowerhealth.example/oauth/authorize/req-1/{page}")
            );
        }
    }

    /// A slash, a space and a question mark in the id are percent-encoded, so
    /// the id stays one path segment.
    #[test]
    fn a_request_page_location_keeps_the_id_one_segment() {
        assert_eq!(
            request_page_location("a/b c?", "wait"),
            "authorize/a%2Fb%20c%3F/wait"
        );
    }
}
