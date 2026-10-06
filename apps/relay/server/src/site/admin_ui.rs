//! The admin UI on `admin.<domain>`: the static files `apps/relay/admin-web`
//! builds, embedded in the binary at compile time (see `build.rs`).
//!
//! - `GET /` serves `index.html`; `GET /<path>` the embedded file at that
//!   path, or `404`.
//! - `index.html`, and anything else outside `assets/`, is
//!   `Cache-Control: no-cache`, so a new deploy is picked up on the next
//!   load. `assets/` holds Vite's content-hashed files, which never change
//!   under a name and are `immutable`.
//! - Every file carries [`CONTENT_SECURITY_POLICY`], `nosniff` and
//!   `Referrer-Policy: no-referrer`: the page holds the admin key, so it runs
//!   nothing but its own files.
//!
//! On any other `Host` these paths are `404`, as the admin API's are. The
//! page signs its own calls to the admin API (see [`super::admin`]); serving
//! it needs no signature.

use std::path::Path as FilePath;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use include_dir::{include_dir, Dir};

use super::admin::require_admin_host;

/// `apps/relay/admin-web/dist`, as it was when the relay was compiled.
static WEB_DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../admin-web/dist");

/// Only the page's own files: no inline script or style, no other origin, no
/// `<base>`, no form submissions, and no framing.
const CONTENT_SECURITY_POLICY: &str =
    "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Vite's content-hashed output.
const ASSETS_DIR: &str = "assets/";

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

/// The routes above, serving the embedded build on `admin_hostname`.
pub(super) fn router(admin_hostname: Arc<str>) -> axum::Router {
    router_for(&WEB_DIST, admin_hostname)
}

/// The routes above, serving `files`.
fn router_for(files: &'static Dir<'static>, admin_hostname: Arc<str>) -> axum::Router {
    axum::Router::new()
        .route("/", get(index))
        .route("/{*path}", get(file))
        .route_layer(middleware::from_fn_with_state(
            admin_hostname,
            require_admin_host,
        ))
        .with_state(files)
}

async fn index(State(files): State<&'static Dir<'static>>) -> Response {
    serve(files, "index.html")
}

async fn file(State(files): State<&'static Dir<'static>>, Path(path): Path<String>) -> Response {
    serve(files, &path)
}

/// The embedded file at `path`, with its headers, or `404`.
fn serve(files: &'static Dir<'static>, path: &str) -> Response {
    let Some(file) = files.get_file(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cache_control = if path.starts_with(ASSETS_DIR) {
        IMMUTABLE
    } else {
        NO_CACHE
    };
    (
        [
            (header::CONTENT_TYPE, content_type(path)),
            (header::CACHE_CONTROL, cache_control),
            (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        file.contents(),
    )
        .into_response()
}

/// The media type of a built file, by its extension.
fn content_type(path: &str) -> &'static str {
    match FilePath::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
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

    const ADMIN_HOST: &str = "admin.relay.example.com";

    /// A build as Vite lays it out: `index.html` and hashed files under
    /// `assets/`.
    static DIST: Dir<'static> = Dir::new(
        "",
        &[
            DirEntry::File(File::new(
                "index.html",
                b"<!doctype html><title>Relay admin</title>",
            )),
            DirEntry::Dir(Dir::new(
                "assets",
                &[
                    DirEntry::File(File::new("assets/main-abc123.js", b"console.log(1)")),
                    DirEntry::File(File::new("assets/main-abc123.css", b"body{}")),
                    DirEntry::File(File::new("assets/font-def456.woff2", b"wOF2")),
                ],
            )),
        ],
    );

    async fn get_from(host: &str, uri: &str) -> Response {
        router_for(&DIST, ADMIN_HOST.into())
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn body(response: Response) -> Vec<u8> {
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }

    fn assert_locked_down(response: &Response, uri: &str) {
        let headers = response.headers();
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "{uri}"
        );
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{uri}");
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer", "{uri}");
    }

    #[tokio::test]
    async fn the_admin_host_serves_index_html_at_the_root_uncached() {
        let response = get_from(ADMIN_HOST, "/").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_locked_down(&response, "/");
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
        assert_eq!(
            body(response).await,
            b"<!doctype html><title>Relay admin</title>"
        );
    }

    #[tokio::test]
    async fn the_admin_host_serves_hashed_assets_as_immutable_with_their_types() {
        for (uri, content_type, contents) in [
            (
                "/assets/main-abc123.js",
                "text/javascript; charset=utf-8",
                &b"console.log(1)"[..],
            ),
            (
                "/assets/main-abc123.css",
                "text/css; charset=utf-8",
                &b"body{}"[..],
            ),
            ("/assets/font-def456.woff2", "font/woff2", &b"wOF2"[..]),
        ] {
            // The port a browser leaves out of `Host` for https is ignored.
            let response = get_from("Admin.Relay.Example.com:443", uri).await;
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_locked_down(&response, uri);
            let headers = response.headers();
            assert_eq!(headers[header::CONTENT_TYPE], content_type, "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], IMMUTABLE, "{uri}");
            assert_eq!(body(response).await, contents, "{uri}");
        }
    }

    #[tokio::test]
    async fn unknown_paths_and_directories_are_not_found() {
        for uri in [
            "/nothing.js",
            "/assets",
            "/assets/",
            "/assets/../index.html",
        ] {
            let response = get_from(ADMIN_HOST, uri).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    /// The UI exists only on `admin.<domain>`, for every method.
    #[tokio::test]
    async fn other_hosts_get_404() {
        for host in ["relay.example.com", "alice.relay.example.com"] {
            for uri in ["/", "/index.html", "/assets/main-abc123.js"] {
                let response = get_from(host, uri).await;
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{host}{uri}");
            }
        }
        let response = router_for(&DIST, ADMIN_HOST.into())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(header::HOST, "relay.example.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// Whatever was built (or stubbed) into this binary has a page to serve.
    #[test]
    fn the_embedded_build_has_an_index_html() {
        assert!(WEB_DIST.get_file("index.html").is_some());
    }
}
