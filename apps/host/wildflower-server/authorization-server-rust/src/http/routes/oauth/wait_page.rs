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

use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use super::pages::{page_security_headers, request_page_location};
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;

const WAIT_PAGE_HTML: &str = include_str!("wait_page/wait.html");
const WAIT_PAGE_SCRIPT: &str = include_str!("wait_page/wait.js");
const WAIT_PAGE_STYLESHEET: &str = include_str!("wait_page/wait.css");

/// The wait page's routes, relative to the `/oauth` mount. The page references
/// its assets as `../wait.js` and `../wait.css`, which resolve to these two
/// siblings whatever prefix the authorization server is mounted under.
pub(crate) fn router() -> Router<Arc<AuthorizationServerState>> {
    Router::new()
        .route("/authorize/{id}/wait", get(|| async { wait_page() }))
        .route("/authorize/wait.js", get(|| async { wait_page_script() }))
        .route(
            "/authorize/wait.css",
            get(|| async { wait_page_stylesheet() }),
        )
}

/// The `Location` `/oauth/authorize` parks a browser at for pending request
/// `request_id` when its session can't approve it: relative, so the browser
/// resolves it against the `…/oauth/authorize` it just requested.
pub(crate) fn wait_page_location(request_id: &str) -> String {
    request_page_location(request_id, "wait")
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
/// like the status poll it drives, so an authorization server update never leaves a stale
/// script polling a changed endpoint.
fn page_file(content_type: &'static str, body: &'static str) -> Response {
    CacheSuppressed((page_security_headers(content_type), body)).into_response()
}
