//! The **authorization pages**: the React pages the authorization server serves
//! on its own origin, so the address bar names the server being approved. They
//! are the build of `apps/host/wildflower-server/authorization-server-web`,
//! embedded in the binary at compile time (see `build.rs`):
//!
//! - `GET /oauth/authorize/{id}/consent` serves the consent card,
//!   `consent.html`, the same bytes whatever the id: the page reads the id from
//!   its own path. Uncached, like the wait page.
//! - `GET /oauth/device` serves the device verification page, `device.html`:
//!   the RFC 8628 `verification_uri`, and with `?user_code=` its
//!   `verification_uri_complete`. The same bytes whatever the query: the page
//!   reads the code from its own URL. Uncached.
//! - `GET /oauth/assets/{file}` serves the pages' scripts, stylesheets and
//!   fonts, Vite's content-hashed files, which never change under a name and
//!   are cached as `immutable`. Only `.js`, `.css` and `.woff2` files are
//!   served; anything else is `404`.
//!
//! Every file carries the wait page's security headers
//! ([`page_security_headers`]). The pages call only the existing APIs
//! (`/authorization/*` and FHIR `GET /Patient`), on the Owner browser
//! session's bearer, which the host's cookie→bearer layer presents for them.

use std::path::Path as FilePath;
use std::sync::Arc;

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use include_dir::{include_dir, Dir};
use url::form_urlencoded;

use super::pages::{page_security_headers, request_page_location};
use super::OAUTH_MOUNT;
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;

/// `apps/host/wildflower-server/authorization-server-web/dist`, as it was when
/// the authorization server was compiled.
static AUTHORIZATION_PAGES: Dir<'static> =
    include_dir!("$CARGO_MANIFEST_DIR/../authorization-server-web/dist");

/// The consent card's page in the build.
const CONSENT_PAGE: &str = "consent.html";

/// The device verification page in the build.
const DEVICE_PAGE: &str = "device.html";

/// Where the device verification page is served, relative to
/// [`OAUTH_MOUNT`].
const DEVICE_PAGE_ROUTE: &str = "/device";

/// Vite's content-hashed output, served at `/oauth/assets/`.
const ASSETS_DIR: &str = "assets";

/// How long a browser may keep a hashed asset: a year, without revalidating.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// The pages' routes, relative to the `/oauth` mount.
pub(crate) fn router() -> Router<Arc<AuthorizationServerState>> {
    router_for(&AUTHORIZATION_PAGES)
}

/// The `Location` `/oauth/authorize` sends a browser signed in as the Owner to
/// for pending request `request_id`: the consent card, beside the endpoint, on
/// the origin the browser used.
pub(crate) fn consent_page_location(request_id: &str) -> String {
    request_page_location(request_id, "consent")
}

/// The RFC 8628 `verification_uri` of the server at `served_origin`: the
/// device verification page.
pub(crate) fn device_page_url(served_origin: &str) -> String {
    format!("{served_origin}{OAUTH_MOUNT}{DEVICE_PAGE_ROUTE}")
}

/// The RFC 8628 `verification_uri_complete` of the server at `served_origin`:
/// the device verification page with `user_code` in its query, which the page
/// fills its code box from and still asks the Owner to confirm.
pub(crate) fn device_page_url_with_code(served_origin: &str, user_code: &str) -> String {
    let encoded_user_code =
        form_urlencoded::byte_serialize(user_code.as_bytes()).collect::<String>();
    format!(
        "{}?user_code={encoded_user_code}",
        device_page_url(served_origin)
    )
}

/// The routes above, serving `pages`. They read no router state.
fn router_for<S: Clone + Send + Sync + 'static>(pages: &'static Dir<'static>) -> Router<S> {
    Router::new()
        .route(
            "/authorize/{id}/consent",
            get(move || async move { page(pages, CONSENT_PAGE) }),
        )
        .route(
            DEVICE_PAGE_ROUTE,
            get(move || async move { page(pages, DEVICE_PAGE) }),
        )
        .route(
            "/assets/{*file}",
            get(move |Path(file): Path<String>| async move { asset(pages, &file) }),
        )
}

/// The page `name` from `pages`, uncached, or `404` when the build has none.
fn page(pages: &'static Dir<'static>, name: &str) -> Response {
    let Some(page) = pages.get_file(name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    CacheSuppressed((
        page_security_headers("text/html; charset=utf-8"),
        page.contents(),
    ))
    .into_response()
}

/// The hashed script, stylesheet or font `file` under `pages`' `assets/`,
/// cached as immutable, or `404`.
fn asset(pages: &'static Dir<'static>, file: &str) -> Response {
    let Some(content_type) = asset_content_type(file) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(asset) = pages.get_file(format!("{ASSETS_DIR}/{file}")) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [(header::CACHE_CONTROL, IMMUTABLE)],
        page_security_headers(content_type),
        asset.contents(),
    )
        .into_response()
}

/// The media type an asset is served as, by its extension: a script, a
/// stylesheet or a font, the only files a page loads under its CSP. `None` for
/// anything else.
fn asset_content_type(file: &str) -> Option<&'static str> {
    match FilePath::new(file)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("js") => Some("text/javascript; charset=utf-8"),
        Some("css") => Some("text/css; charset=utf-8"),
        Some("woff2") => Some("font/woff2"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use include_dir::{DirEntry, File};
    use tower::ServiceExt;

    use super::*;

    /// A build as Vite lays it out: the page, and hashed files under
    /// `assets/`.
    static PAGES: Dir<'static> = Dir::new(
        "",
        &[
            DirEntry::File(File::new(
                "consent.html",
                b"<!doctype html><title>Approve</title>",
            )),
            DirEntry::File(File::new(
                "device.html",
                b"<!doctype html><title>Authorize a device</title>",
            )),
            DirEntry::Dir(Dir::new(
                "assets",
                &[
                    DirEntry::File(File::new("assets/consent-abc123.js", b"console.log(1)")),
                    DirEntry::File(File::new("assets/react-def456.js", b"export{}")),
                    DirEntry::File(File::new("assets/consent-abc123.css", b"body{}")),
                    DirEntry::File(File::new("assets/sans-latin-1a2b3c.woff2", b"wOF2")),
                    DirEntry::File(File::new("assets/sans-latin-1a2b3c.woff", b"wOFF")),
                    DirEntry::File(File::new("assets/logo-0a1b2c.svg", b"<svg/>")),
                ],
            )),
        ],
    );

    async fn get(uri: &str) -> Response {
        router_for::<()>(&PAGES)
            .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
            .await
            .expect("infallible")
    }

    async fn body(response: Response) -> Vec<u8> {
        response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .to_vec()
    }

    fn header_of(response: &Response, name: header::HeaderName) -> &str {
        response
            .headers()
            .get(&name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_else(|| panic!("{name}"))
    }

    fn assert_locked_down(response: &Response, uri: &str) {
        assert_eq!(
            header_of(response, header::CONTENT_SECURITY_POLICY),
            "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; \
             connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "{uri}"
        );
        assert_eq!(
            header_of(response, header::REFERRER_POLICY),
            "no-referrer",
            "{uri}"
        );
        assert_eq!(
            header_of(response, header::X_CONTENT_TYPE_OPTIONS),
            "nosniff",
            "{uri}"
        );
    }

    #[tokio::test]
    async fn the_consent_card_is_the_same_uncached_page_for_every_request() {
        for uri in [
            "/authorize/req-1/consent",
            "/authorize/%3Cscript%3E/consent",
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_locked_down(&response, uri);
            assert_eq!(
                header_of(&response, header::CONTENT_TYPE),
                "text/html; charset=utf-8",
                "{uri}"
            );
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL),
                "no-store",
                "{uri}"
            );
            assert_eq!(
                body(response).await,
                b"<!doctype html><title>Approve</title>",
                "{uri}"
            );
        }
    }

    #[tokio::test]
    async fn the_device_page_is_the_same_uncached_page_with_or_without_a_code() {
        for uri in [
            "/device",
            "/device?user_code=WDJB-MJHT",
            "/device?user_code=%3Cscript%3E",
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_locked_down(&response, uri);
            assert_eq!(
                header_of(&response, header::CONTENT_TYPE),
                "text/html; charset=utf-8",
                "{uri}"
            );
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL),
                "no-store",
                "{uri}"
            );
            assert_eq!(
                body(response).await,
                b"<!doctype html><title>Authorize a device</title>",
                "{uri}"
            );
        }
    }

    #[test]
    fn the_device_page_urls_are_on_the_served_origin_with_the_code_encoded() {
        assert_eq!(
            device_page_url("https://ruth.relay.example"),
            "https://ruth.relay.example/oauth/device"
        );
        assert_eq!(
            device_page_url_with_code("https://ruth.relay.example", "WDJB-MJHT"),
            "https://ruth.relay.example/oauth/device?user_code=WDJB-MJHT"
        );
        assert_eq!(
            device_page_url_with_code("https://ruth.relay.example", "a&b c"),
            "https://ruth.relay.example/oauth/device?user_code=a%26b+c"
        );
    }

    #[tokio::test]
    async fn hashed_scripts_stylesheets_and_fonts_are_immutable_with_their_types() {
        for (uri, content_type, contents) in [
            (
                "/assets/consent-abc123.js",
                "text/javascript; charset=utf-8",
                &b"console.log(1)"[..],
            ),
            (
                "/assets/react-def456.js",
                "text/javascript; charset=utf-8",
                &b"export{}"[..],
            ),
            (
                "/assets/consent-abc123.css",
                "text/css; charset=utf-8",
                &b"body{}"[..],
            ),
            (
                "/assets/sans-latin-1a2b3c.woff2",
                "font/woff2",
                &b"wOF2"[..],
            ),
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_locked_down(&response, uri);
            assert_eq!(
                header_of(&response, header::CONTENT_TYPE),
                content_type,
                "{uri}"
            );
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL),
                "public, max-age=31536000, immutable",
                "{uri}"
            );
            assert_eq!(body(response).await, contents, "{uri}");
        }
    }

    #[tokio::test]
    async fn anything_but_a_built_script_stylesheet_or_font_is_not_found() {
        for uri in [
            "/assets/nothing.js",
            "/assets/nothing.woff2",
            "/assets/sans-latin-1a2b3c.woff",
            "/assets/logo-0a1b2c.svg",
            "/assets/../consent.html",
            "/assets/%2E%2E/consent.html",
            "/consent.html",
            "/device.html",
            "/device/WDJB-MJHT",
            "/authorize/req-1/consent.html",
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    /// Whatever was built (or stubbed) into this binary has a consent page and
    /// a device page to serve.
    #[test]
    fn the_embedded_build_has_the_consent_and_device_pages() {
        assert!(AUTHORIZATION_PAGES.get_file(CONSENT_PAGE).is_some());
        assert!(AUTHORIZATION_PAGES.get_file(DEVICE_PAGE).is_some());
    }
}
