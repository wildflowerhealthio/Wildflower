//! The **wait page**: the page `/oauth/authorize` parks a browser on while the
//! Owner decides, when its browser session can't approve the request itself.
//! Served by the
//! authorization server itself, on the server's origin, so the only address a
//! sign-in ever leaves the authorization server for is the one the status poll
//! hands back — a redirect built from the client's allowlisted (or
//! just-approved) `redirect_uri`. While the request is pending,
//! the page also checks whether the browser has since signed in as the Owner
//! (it can read the request's consent) and, if so, switches to the consent
//! card beside it on the same origin. The concept is the "Wait page" entry of
//! `slices/authorization/docs/Jargon Explanation.md`.
//!
//! The three files under `wait_page/` are embedded verbatim, with nothing
//! interpolated: `wait.js` reads the request id from its own path, so a
//! request id can never reach the markup. How they are served is pinned by
//! `tests/integration/wait_page.rs`; the script itself has no tests.

use std::sync::Arc;

use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use super::pages::{
    content_security_policy, page_security_headers, request_page_location, NO_FORM_TARGETS,
};
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;

/// The wait page's markup, the same bytes for every request.
const WAIT_PAGE_HTML: &str = include_str!("wait_page/wait.html");
/// The wait page's script: it reads the request id from the page's path,
/// polls the status, and follows the redirect the poll hands back.
const WAIT_PAGE_SCRIPT: &str = include_str!("wait_page/wait.js");
/// The wait page's stylesheet.
const WAIT_PAGE_STYLESHEET: &str = include_str!("wait_page/wait.css");

/// The wait page's routes, relative to the `/oauth` mount. The page references
/// its assets as `../wait.js` and `../wait.css`, which resolve to these two
/// siblings whatever prefix the authorization server is mounted under.
pub(crate) fn router() -> Router<Arc<AuthorizationServerState>> {
    let policy = content_security_policy(NO_FORM_TARGETS);
    let script_policy = policy.clone();
    let stylesheet_policy = policy.clone();
    Router::new()
        .route(
            "/authorize/{id}/wait",
            get(move || async move { wait_page(&policy) }),
        )
        .route(
            "/authorize/wait.js",
            get(move || async move { wait_page_script(&script_policy) }),
        )
        .route(
            "/authorize/wait.css",
            get(move || async move { wait_page_stylesheet(&stylesheet_policy) }),
        )
}

/// The `Location` `/oauth/authorize` parks a browser at for pending request
/// `request_id` when its session can't approve it: relative, so the browser
/// resolves it against the `…/oauth/authorize` it just requested.
pub(crate) fn wait_page_location(request_id: &str) -> String {
    request_page_location(request_id, "wait")
}

/// `GET /oauth/authorize/{id}/wait`: the page itself, whatever the id.
fn wait_page(policy: &HeaderValue) -> Response {
    page_file("text/html; charset=utf-8", WAIT_PAGE_HTML, policy)
}

/// `GET /oauth/authorize/wait.js`: the page's script.
fn wait_page_script(policy: &HeaderValue) -> Response {
    page_file("text/javascript; charset=utf-8", WAIT_PAGE_SCRIPT, policy)
}

/// `GET /oauth/authorize/wait.css`: the page's stylesheet.
fn wait_page_stylesheet(policy: &HeaderValue) -> Response {
    page_file("text/css; charset=utf-8", WAIT_PAGE_STYLESHEET, policy)
}

/// One of the page's files, with the page's security headers and `policy`. Cache-suppressed
/// like the status poll it drives, so an authorization server update never leaves a stale
/// script polling a changed endpoint.
fn page_file(content_type: &'static str, body: &'static str, policy: &HeaderValue) -> Response {
    CacheSuppressed((page_security_headers(content_type, policy), body)).into_response()
}
