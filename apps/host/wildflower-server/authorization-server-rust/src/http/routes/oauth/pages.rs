//! What the authorization server's browser pages share: the
//! [wait page](super::wait_page) and the [authorization
//! pages](super::authorization_pages) (the consent card). Each is served on the
//! server's origin, under the same security headers, and is reached at a path beside `/oauth/authorize` that
//! names the pending request.

use axum::http::header::{self, HeaderName};
use url::form_urlencoded;

/// Everything a page loads (its scripts, stylesheets and fonts) comes from
/// this origin, it can only talk back to it, and nothing may frame it. The top-level navigation to the client's
/// redirect is not a fetch, so `connect-src` doesn't constrain it.
pub(super) const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'self'; \
     style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; \
     form-action 'none'; frame-ancestors 'none'";

/// The headers every file of a page carries: its `content_type`, the
/// [`CONTENT_SECURITY_POLICY`], no `Referer` on anything it loads or leaves
/// for, and no sniffing a type other than the one declared.
pub(super) fn page_security_headers(content_type: &'static str) -> [(HeaderName, &'static str); 4] {
    [
        (header::CONTENT_TYPE, content_type),
        (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
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

    #[test]
    fn a_request_page_location_keeps_the_id_one_segment() {
        assert_eq!(
            request_page_location("a/b c?", "wait"),
            "authorize/a%2Fb%20c%3F/wait"
        );
    }
}
