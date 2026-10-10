//! The **wait page**: the page `/oauth/authorize` parks a browser on while the
//! Owner decides. Served by the gatekeeper itself, on whichever origin the
//! browser reached it at, so the only address a sign-in ever leaves the
//! gatekeeper for is the one the status poll hands back — a redirect built from
//! the client's allowlisted (or just-approved) `redirect_uri`. The concept is the
//! "Wait page" entry of `slices/gatekeeper/docs/Jargon Explanation.md`.
//!
//! The three files under `wait_page/` are embedded verbatim, with nothing
//! interpolated: `wait.js` reads the request id from its own path, so a
//! request id can never reach the markup. How they are served is pinned by
//! `tests/integration/wait_page.rs`; the script itself has no tests.

use std::sync::Arc;

use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use url::form_urlencoded;

use crate::http::state::GatekeeperState;
use crate::http::wire_representations::CacheSuppressed;

const WAIT_PAGE_HTML: &str = include_str!("wait_page/wait.html");
const WAIT_PAGE_SCRIPT: &str = include_str!("wait_page/wait.js");
const WAIT_PAGE_STYLESHEET: &str = include_str!("wait_page/wait.css");

/// Everything the page loads comes from this origin, it can only talk back to
/// it, and nothing may frame it. The top-level navigation to the client's
/// redirect is not a fetch, so `connect-src` doesn't constrain it.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'self'; \
     style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; \
     frame-ancestors 'none'";

/// The wait page's routes, relative to the `/oauth` mount. The page references
/// its assets as `../wait.js` and `../wait.css`, which resolve to these two
/// siblings whatever prefix the gatekeeper is mounted under.
pub(crate) fn router() -> Router<Arc<GatekeeperState>> {
    Router::new()
        .route("/authorize/{id}/wait", get(|| async { wait_page() }))
        .route("/authorize/wait.js", get(|| async { wait_page_script() }))
        .route(
            "/authorize/wait.css",
            get(|| async { wait_page_stylesheet() }),
        )
}

/// The `Location` `/oauth/authorize` parks a browser at for pending request
/// `request_id`: relative, so the browser resolves it against the
/// `…/oauth/authorize` it just requested, on the origin it used.
pub(crate) fn wait_page_location(request_id: &str) -> String {
    let encoded_request_id = form_urlencoded::byte_serialize(request_id.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    format!("authorize/{encoded_request_id}/wait")
}

fn wait_page() -> Response {
    page_file("text/html; charset=utf-8", WAIT_PAGE_HTML)
}

fn wait_page_script() -> Response {
    page_file("text/javascript; charset=utf-8", WAIT_PAGE_SCRIPT)
}

fn wait_page_stylesheet() -> Response {
    page_file("text/css; charset=utf-8", WAIT_PAGE_STYLESHEET)
}

/// One of the page's files, with the page's security headers. Cache-suppressed
/// like the status poll it drives, so a gatekeeper update never leaves a stale
/// script polling a changed endpoint.
fn page_file(content_type: &'static str, body: &'static str) -> Response {
    CacheSuppressed((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    ))
    .into_response()
}

#[cfg(test)]
mod tests {
    use url::Url;

    use super::wait_page_location;

    #[test]
    fn wait_page_location_resolves_beside_the_authorize_endpoint() {
        let authorize = Url::parse("https://ruth.wildflowerhealth.example/oauth/authorize?x=1")
            .expect("valid url");
        let resolved = authorize
            .join(&wait_page_location("req-1"))
            .expect("resolves");
        assert_eq!(
            resolved.as_str(),
            "https://ruth.wildflowerhealth.example/oauth/authorize/req-1/wait"
        );
    }

    #[test]
    fn wait_page_location_keeps_the_id_one_segment() {
        assert_eq!(wait_page_location("a/b c?"), "authorize/a%2Fb%20c%3F/wait");
    }
}
