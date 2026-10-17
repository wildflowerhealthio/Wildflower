//! What the authorization server's browser pages share: the
//! [wait page](super::wait_page) and the [authorization
//! pages](super::authorization_pages) (the consent card). Each is served on the
//! server's origin, under the same security headers, and is reached at a path beside `/oauth/authorize` that
//! names the pending request.

use axum::http::header::{self, HeaderName};
use url::form_urlencoded;

/// The `form-action` sources of a page that submits no form.
pub(super) const NO_FORM_TARGETS: &str = "'none'";

/// The `Content-Security-Policy` of a page whose forms may submit to, and
/// follow redirects to, `form_targets` (a `form-action` source list,
/// [`NO_FORM_TARGETS`] for none). Everything a page loads (its scripts,
/// stylesheets and fonts) comes from this origin, it can only talk back to it,
/// and nothing may frame it. The top-level navigation to the client's redirect
/// is not a fetch, so `connect-src` doesn't constrain it.
pub(super) fn content_security_policy(form_targets: &str) -> String {
    format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; \
         connect-src 'self'; base-uri 'none'; form-action {form_targets}; \
         frame-ancestors 'none'"
    )
}

/// The headers every file of a page carries: its `content_type`, its
/// [`content_security_policy`] for `form_targets`, no `Referer` on anything it
/// loads from or leaves for another origin, and no sniffing a type other than
/// the one declared. The referrer policy is `same-origin`, not `no-referrer`:
/// under `no-referrer` a browser sends a form `POST` with `Origin: null`, which
/// the host's cookie→bearer layer refuses, so the pages' Sign out would fail.
pub(super) fn page_security_headers(
    content_type: &'static str,
    form_targets: &str,
) -> [(HeaderName, String); 4] {
    [
        (header::CONTENT_TYPE, content_type.to_owned()),
        (
            header::CONTENT_SECURITY_POLICY,
            content_security_policy(form_targets),
        ),
        (header::REFERRER_POLICY, "same-origin".to_owned()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
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
