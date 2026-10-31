//! The **authorization pages**: the React pages the authorization server serves
//! on its own origin, so the address bar names the server being approved. They
//! are the build of `apps/host/wildflower-server/authorization-server-web`,
//! embedded in the binary at compile time (see `build.rs`):
//!
//! - `GET /oauth/authorize/{id}/consent` serves the consent card,
//!   `consent.html`, the same bytes whatever the id: the page reads the id from
//!   its own path. Uncached, like the wait page.
//! - `GET /oauth/authorize/{id}/limited` serves the limited page,
//!   `limited.html`, where a browser whose session holds less than a request
//!   asks for says whether to go on. The same bytes whatever the id. Uncached.
//! - `GET /oauth/device` serves the device verification page, `device.html`:
//!   the RFC 8628 `verification_uri`, and with `?user_code=` its
//!   `verification_uri_complete`. The same bytes whatever the query: the page
//!   reads the code from its own URL. Uncached.
//! - `GET /oauth/session-widenings/{id}/consent` serves the session
//!   widening's card, `widening.html`, where the Owner decides a browser's
//!   ask to widen its session. The same bytes whatever the id. Uncached.
//! - `GET /oauth/pair?next=…` serves the pairing page, `pair.html`, where a
//!   browser that isn't the Owner's starts a browser pairing, shows its code,
//!   and waits for the Owner's approval. The same bytes whatever the query.
//!   Uncached.
//! - `GET /oauth/assets/{*file}` serves the pages' scripts, stylesheets and
//!   fonts, Vite's content-hashed files, which never change under a name and
//!   are cached as `immutable`. Only `.js`, `.css` and `.woff2` files are
//!   served; anything else is `404`.
//!
//! Every file carries the wait page's security headers
//! ([`page_security_headers`]), but for `form-action`: the pages' footer posts
//! its **Sign out** form to `/oauth/sign-out`, on this origin, which redirects
//! to the hosted launcher, so their policy lets a form submit to this origin
//! and follow a redirect to the launcher's. The consent card and the device
//! page call `/authorization/*` and FHIR `GET /Patient`, on the browser
//! session's bearer, which the host's cookie→bearer layer presents for them,
//! as the widening's card calls `/authorization/session-widenings/*`;
//! the pairing page calls `/oauth/pair/*`, which needs no session; the
//! limited page calls `/oauth/authorize/{id}/*` and
//! `/oauth/session-widenings/{id}/poll`, on the browser session's cookie.

use std::path::Path as FilePath;
use std::sync::Arc;

use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use include_dir::{include_dir, Dir};
use url::{form_urlencoded, Url};
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

use super::pages::{content_security_policy, page_security_headers, request_page_location};
use super::OAUTH_MOUNT;
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;

/// `apps/host/wildflower-server/authorization-server-web/dist`, as it was when
/// the authorization server was compiled.
static AUTHORIZATION_PAGES: Dir<'static> =
    include_dir!("$CARGO_MANIFEST_DIR/../authorization-server-web/dist");

/// The consent card's page in the build.
const CONSENT_PAGE: &str = "consent.html";

/// The limited page in the build.
const LIMITED_PAGE: &str = "limited.html";

/// The limited page's last path segment, after `/oauth/authorize/{id}/`.
const LIMITED_PAGE_SEGMENT: &str = "limited";

/// The session widening's card in the build.
const SESSION_WIDENING_PAGE: &str = "widening.html";

/// The device verification page in the build.
const DEVICE_PAGE: &str = "device.html";

/// Where the device verification page is served, relative to
/// [`OAUTH_MOUNT`].
const DEVICE_PAGE_ROUTE: &str = "/device";

/// The pairing page in the build.
const PAIR_PAGE: &str = "pair.html";

/// The pairing page's query parameter that names where the browser goes once
/// paired.
const NEXT_PARAM: &str = "next";

/// The device page's query parameter that carries the code it fills in.
const USER_CODE_PARAM: &str = "user_code";

/// Vite's content-hashed output, served at `/oauth/assets/`.
const ASSETS_DIR: &str = "assets";

/// How long a browser may keep a hashed asset: a year, without revalidating.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// The pages' routes, relative to the `/oauth` mount. `launcher_base` is
/// where the sign-out the pages' form posts to sends the browser.
pub(crate) fn router(launcher_base: &LauncherBase) -> Router<Arc<AuthorizationServerState>> {
    router_for(&AUTHORIZATION_PAGES, &sign_out_form_targets(launcher_base))
}

/// The `form-action` sources of a page whose sign-out form posts to this
/// origin, and is redirected on to the launcher at `launcher_base`.
fn sign_out_form_targets(launcher_base: &LauncherBase) -> String {
    format!(
        "'self' {}",
        launcher_base.as_url().origin().ascii_serialization()
    )
}

/// The `Location` `/oauth/authorize` sends a browser whose session can decide
/// pending request `request_id` to: the consent card, beside the endpoint.
pub(crate) fn consent_page_location(request_id: &str) -> String {
    request_page_location(request_id, "consent")
}

/// The `Location` `/oauth/authorize` sends a browser whose session holds less
/// than pending request `request_id` asks for: the limited page, beside the
/// endpoint.
pub(crate) fn limited_page_location(request_id: &str) -> String {
    request_page_location(request_id, LIMITED_PAGE_SEGMENT)
}

/// The `Location` `/oauth/authorize` sends a browser without a browser session
/// to: the pairing page, beside the endpoint, with `next` (the path and query
/// of the authorize request it made, on this origin) in its query, so the
/// page sends the paired browser back to it.
pub(crate) fn pairing_page_location(next: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair(NEXT_PARAM, next)
        .finish();
    format!("pair?{query}")
}

/// The RFC 8628 `verification_uri` of the server at `server_origin`: the
/// device verification page.
pub(crate) fn device_page_url(server_origin: &Url) -> Url {
    let mut device_page = server_origin.clone();
    device_page.set_path(&format!("{OAUTH_MOUNT}{DEVICE_PAGE_ROUTE}"));
    device_page
}

/// The RFC 8628 `verification_uri_complete` for `user_code`: `device_page`
/// (see [`device_page_url`]) with the code in its query, which the page fills
/// its code box from and still asks the Owner to confirm.
pub(crate) fn device_page_url_with_code(device_page: &Url, user_code: &str) -> Url {
    let mut url = device_page.clone();
    url.query_pairs_mut()
        .append_pair(USER_CODE_PARAM, user_code);
    url
}

/// The routes above, serving `pages`, whose forms may submit to
/// `form_targets`. The policy is built once, here. They read no router state.
fn router_for<S: Clone + Send + Sync + 'static>(
    pages: &'static Dir<'static>,
    form_targets: &str,
) -> Router<S> {
    let policy = content_security_policy(form_targets);
    let consent_policy = policy.clone();
    let limited_policy = policy.clone();
    let widening_policy = policy.clone();
    let device_policy = policy.clone();
    let pair_policy = policy.clone();
    Router::new()
        .route(
            "/authorize/{id}/consent",
            get(move || async move { page(pages, CONSENT_PAGE, &consent_policy) }),
        )
        .route(
            "/authorize/{id}/limited",
            get(move || async move { page(pages, LIMITED_PAGE, &limited_policy) }),
        )
        .route(
            "/session-widenings/{id}/consent",
            get(move || async move { page(pages, SESSION_WIDENING_PAGE, &widening_policy) }),
        )
        .route(
            DEVICE_PAGE_ROUTE,
            get(move || async move { page(pages, DEVICE_PAGE, &device_policy) }),
        )
        .route(
            "/pair",
            get(move || async move { page(pages, PAIR_PAGE, &pair_policy) }),
        )
        .route(
            "/assets/{*file}",
            get(move |Path(file): Path<String>| async move { asset(pages, &file, &policy) }),
        )
}

/// The page `name` from `pages`, uncached, under `policy`, or `404` when the
/// build has none.
fn page(pages: &'static Dir<'static>, name: &str, policy: &HeaderValue) -> Response {
    let Some(page) = pages.get_file(name) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    CacheSuppressed((
        page_security_headers("text/html; charset=utf-8", policy),
        page.contents(),
    ))
    .into_response()
}

/// The hashed script, stylesheet or font `file` under `pages`' `assets/`,
/// cached as immutable, under `policy`, or `404`.
fn asset(pages: &'static Dir<'static>, file: &str, policy: &HeaderValue) -> Response {
    let Some(content_type) = asset_content_type(file) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(asset) = pages.get_file(format!("{ASSETS_DIR}/{file}")) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [(header::CACHE_CONTROL, IMMUTABLE)],
        page_security_headers(content_type, policy),
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

    /// A build as Vite lays it out: the five pages, and hashed files under
    /// `assets/`, among them a `.woff` and an `.svg` the routes must refuse.
    static PAGES: Dir<'static> = Dir::new(
        "",
        &[
            DirEntry::File(File::new(
                "consent.html",
                b"<!doctype html><title>Approve</title>",
            )),
            DirEntry::File(File::new(
                "limited.html",
                b"<!doctype html><title>Limited access</title>",
            )),
            DirEntry::File(File::new(
                "widening.html",
                b"<!doctype html><title>Widen access</title>",
            )),
            DirEntry::File(File::new(
                "device.html",
                b"<!doctype html><title>Authorize a device</title>",
            )),
            DirEntry::File(File::new(
                "pair.html",
                b"<!doctype html><title>Sign in this browser</title>",
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

    /// The launcher a sign-out sends the browser to: a path on its own origin.
    fn launcher_base() -> LauncherBase {
        LauncherBase::parse("https://launcher.test/launcher/").expect("launcher base")
    }

    /// One `GET` of `uri` to the routes over the fake build, with the
    /// launcher's origin as a form target.
    async fn get(uri: &str) -> Response {
        router_for::<()>(&PAGES, &sign_out_form_targets(&launcher_base()))
            .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
            .await
            .expect("infallible")
    }

    /// The whole body of `response`.
    async fn body(response: Response) -> Vec<u8> {
        response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .to_vec()
    }

    /// The value of header `name` on `response`; panics when it is missing.
    fn header_of(response: &Response, name: header::HeaderName) -> &str {
        response
            .headers()
            .get(&name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_else(|| panic!("{name}"))
    }

    /// Asserts the headers every page and asset carries: the policy naming
    /// this origin and the launcher's as form targets, `Referrer-Policy:
    /// same-origin`, and `nosniff`.
    fn assert_locked_down(response: &Response, uri: &str) {
        assert_eq!(
            header_of(response, header::CONTENT_SECURITY_POLICY),
            "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; \
             connect-src 'self'; base-uri 'none'; form-action 'self' https://launcher.test; \
             frame-ancestors 'none'",
            "{uri}"
        );
        assert_eq!(
            header_of(response, header::REFERRER_POLICY),
            "same-origin",
            "{uri}"
        );
        assert_eq!(
            header_of(response, header::X_CONTENT_TYPE_OPTIONS),
            "nosniff",
            "{uri}"
        );
    }

    /// The consent card is the same locked-down, `no-store` HTML whatever the id,
    /// an id spelling `<script>` included.
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

    /// The limited page is the same locked-down, `no-store` page whatever the id.
    #[tokio::test]
    async fn the_limited_page_is_the_same_uncached_page_for_every_request() {
        for uri in [
            "/authorize/req-1/limited",
            "/authorize/%3Cscript%3E/limited",
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_locked_down(&response, uri);
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL),
                "no-store",
                "{uri}"
            );
            assert_eq!(
                body(response).await,
                b"<!doctype html><title>Limited access</title>",
                "{uri}"
            );
        }
    }

    /// A session widening's card is the same locked-down, `no-store` page
    /// whatever the id.
    #[tokio::test]
    async fn the_widening_card_is_the_same_uncached_page_for_every_widening() {
        for uri in [
            "/session-widenings/widen-1/consent",
            "/session-widenings/%3Cscript%3E/consent",
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_locked_down(&response, uri);
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL),
                "no-store",
                "{uri}"
            );
            assert_eq!(
                body(response).await,
                b"<!doctype html><title>Widen access</title>",
                "{uri}"
            );
        }
    }

    /// The limited page's redirect resolves beside `/oauth/authorize` to the
    /// page for that request, whatever its id holds.
    #[test]
    fn the_limited_location_resolves_to_the_limited_page() {
        let authorize =
            Url::parse("https://ruth.relay.example/oauth/authorize?x=1").expect("valid url");
        assert_eq!(
            authorize
                .join(&limited_page_location("req 1/?"))
                .expect("resolves")
                .path(),
            "/oauth/authorize/req%201%2F%3F/limited"
        );
    }

    /// The device page is the same locked-down, `no-store` HTML with no code, a
    /// code, or markup as the code.
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

    /// The pairing page is the same locked-down, `no-store` page whatever its
    /// `next`.
    #[tokio::test]
    async fn the_pairing_page_is_the_same_uncached_page_whatever_its_next() {
        for uri in [
            "/pair",
            "/pair?next=%2Foauth%2Fauthorize%3Fclient_id%3Dapp",
            "/pair?next=%3Cscript%3E",
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_locked_down(&response, uri);
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL),
                "no-store",
                "{uri}"
            );
            assert_eq!(
                body(response).await,
                b"<!doctype html><title>Sign in this browser</title>",
                "{uri}"
            );
        }
    }

    /// The pairing redirect resolves beside `/oauth/authorize` to the pairing
    /// page, and its `next` decodes back to the authorize request's own path
    /// and query, whatever they hold.
    #[test]
    fn the_pairing_location_resolves_to_the_pairing_page_carrying_next() {
        let authorize =
            Url::parse("https://ruth.relay.example/oauth/authorize?x=1").expect("valid url");
        for next in [
            "/oauth/authorize?client_id=app&scope=a%20b&redirect_uri=https%3A%2F%2Fapp%2Fcb",
            "/oauth/authorize?state=a&b#c+d",
        ] {
            let resolved = authorize
                .join(&pairing_page_location(next))
                .expect("resolves");
            assert_eq!(resolved.path(), "/oauth/pair");
            let nexts: Vec<String> = resolved
                .query_pairs()
                .filter(|(name, _)| name == NEXT_PARAM)
                .map(|(_, value)| value.into_owned())
                .collect();
            assert_eq!(nexts, [next]);
        }
    }

    /// Both device page URLs keep the server origin's port, and a code holding `&`
    /// and a space is form-encoded.
    #[test]
    fn the_device_page_urls_are_on_the_server_origin_with_the_code_encoded() {
        let device_page =
            device_page_url(&Url::parse("https://ruth.relay.example:8443").expect("an origin"));
        assert_eq!(
            device_page.as_str(),
            "https://ruth.relay.example:8443/oauth/device"
        );
        assert_eq!(
            device_page_url_with_code(&device_page, "WDJB-MJHT").as_str(),
            "https://ruth.relay.example:8443/oauth/device?user_code=WDJB-MJHT"
        );
        assert_eq!(
            device_page_url_with_code(&device_page, "a&b c").as_str(),
            "https://ruth.relay.example:8443/oauth/device?user_code=a%26b+c"
        );
    }

    /// Scripts, a stylesheet and a `.woff2` font are served with their types,
    /// locked down, and cached for a year as `immutable`.
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

    /// A missing asset, a `.woff`, an `.svg`, a path climbing out of `assets/`, a
    /// page by its file name, and a path under the device page are all `404`.
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
            "/pair.html",
            "/limited.html",
            "/widening.html",
            "/device/WDJB-MJHT",
            "/authorize/req-1/consent.html",
        ] {
            let response = get(uri).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    /// Whatever was built (or stubbed) into this binary has a consent page, a
    /// limited page, a widening's card, a device page and a pairing page to
    /// serve.
    #[test]
    fn the_embedded_build_has_every_page() {
        assert!(AUTHORIZATION_PAGES.get_file(CONSENT_PAGE).is_some());
        assert!(AUTHORIZATION_PAGES.get_file(LIMITED_PAGE).is_some());
        assert!(AUTHORIZATION_PAGES
            .get_file(SESSION_WIDENING_PAGE)
            .is_some());
        assert!(AUTHORIZATION_PAGES.get_file(DEVICE_PAGE).is_some());
        assert!(AUTHORIZATION_PAGES.get_file(PAIR_PAGE).is_some());
    }
}
