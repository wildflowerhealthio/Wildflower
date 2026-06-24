//! Host-side serving of static "installed apps" from a runtime directory.
//!
//! Each installed app runs on its **own dedicated loopback origin** —
//! `http://{loopback_host}:{port}/` — and is served from the **root** of
//! that origin. The host binds one loopback `TcpListener` per app and
//! `axum::serve`s the [`Router`] this crate builds onto it.
//! [`setup_installed_app`] returns that router, given the app's id and
//! the on-disk directory holding its files (e.g.
//! `app-data/installed-apps/patient-browser/`).
//!
//! Per-origin isolation matters because installed apps are third-party
//! code that the Tauri webview eventually treats as SMART-on-FHIR clients:
//! a distinct origin means a distinct security context (its own storage
//! and cookies, no Same-Origin Policy share with the API on `:8080`).
//! Serving at the root rather than under `/installed-apps/<id>/` also
//! means the upstream build's root-absolute `/assets/`, `/img/`,
//! `/config/` URLs are correct as-is — no HTML rebase is required.
//!
//! Two patient-browser-specific touches stay in place:
//!
//!  - `config/default.json5` is served from the committed, version-controlled
//!    [`PATIENT_BROWSER_CONFIG`] regardless of what's on disk (so the
//!    on-device FHIR URL lives in a readable file, not a brittle rewrite of
//!    the upstream build).
//!  - The `Cache-Control` middleware pins fingerprinted assets (`assets/`,
//!    `img/`, fonts) for a year and keeps `index.html` / `config/*`
//!    short-lived so a redeploy can repoint them.
//!
//! Static-file delivery (path traversal protection, content-type detection
//! via `mime_guess`, directory → `index.html`) is delegated to
//! [`tower_http::services::ServeDir`].
//!
//! When the app's directory is absent or empty the routes 404 — a fresh
//! clone or CI serves nothing until the directory is populated (see
//! slices/apps/vendor-apps/README). The crate has no Tauri/GTK dependency,
//! so it compiles in the main Rust CI; only the host that binds the
//! listener pulls in Tauri.

use std::path::PathBuf;

use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use tower_http::services::ServeDir;

#[cfg(test)]
use axum::body::Body;

/// App id of the vendored patient-browser SPA — the one app that gets the
/// committed-config override today. Match is case-sensitive: the host
/// passes the id from the seeded internal-apps row.
const PATIENT_BROWSER_ID: &str = "patient-browser";

/// Mount-relative key of the patient-browser SMART config under its served
/// root. Matched case-insensitively in the middleware so e.g.
/// `Config/Default.JSON5` still hits the override.
const PATIENT_BROWSER_CONFIG_KEY_LOWER: &str = "config/default.json5";

/// The committed, version-controlled SMART config for patient-browser. Embedded
/// (it's tiny and authoritative — the on-device FHIR URL + timeout) and served
/// at `/config/default.json5` so it survives whatever dist the directory
/// happens to hold.
const PATIENT_BROWSER_CONFIG: &str = include_str!("../patient-browser-config/default.json5");

/// Fingerprinted bundles (`assets/`, `img/`, fonts) never change for a given
/// build, so they cache for a year. `index.html` and `config/*` are the
/// rotation points a redeploy can repoint, so they stay short-lived with
/// revalidation.
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const SHORT_CACHE_CONTROL: &str = "public, max-age=60, must-revalidate";

/// The app id of the router being served, propagated through axum's
/// request extensions so the response-transform middleware can decide
/// whether the patient-browser config override applies — no per-app
/// captured-closure middleware required.
#[derive(Clone)]
struct AppId(String);

/// Router serving one installed app from `app_dir` at the root of its
/// loopback origin. `app_id` selects any app-specific behavior (today
/// only `patient-browser`'s config override).
///
/// `app_dir` is the directory whose children are the app's served files
/// (e.g. `index.html`, `assets/…`); it need not exist yet — a missing file
/// (or missing directory) is a plain 404.
pub fn setup_installed_app(app_id: &str, app_dir: PathBuf) -> Router {
    let mut router = Router::new();
    if app_id == PATIENT_BROWSER_ID {
        // The committed SMART config wins over any on-disk file at this
        // path. Registered as a fixed route (case-sensitive at the axum
        // layer) — the middleware below catches case-variant requests
        // that fall through to ServeDir.
        router = router.route(
            &format!("/{PATIENT_BROWSER_CONFIG_KEY_LOWER}"),
            get(serve_patient_browser_config_override),
        );
    }
    router
        // Everything else: the host-provided directory, served at root by
        // ServeDir (traversal protection + mime_guess content types +
        // directory → index.html resolution all handled there).
        .fallback_service(ServeDir::new(app_dir).append_index_html_on_directories(true))
        // After the file is fetched: intercept case-variant config-override
        // requests (patient-browser only) and set Cache-Control. The middleware
        // reads its app id from the `Extension` layered below so the
        // closure doesn't need to capture it.
        .layer(middleware::from_fn(cache_and_override))
        .layer(Extension(AppId(app_id.to_owned())))
}

/// Serve the committed patient-browser config inline. Returned as
/// `application/json; charset=utf-8` with the short cache so a redeploy can
/// repoint the on-device FHIR URL without clients pinning to a stale copy.
/// Uses axum's tuple-into-response so no `.expect()` panic can leak from a
/// response builder.
async fn serve_patient_browser_config_override() -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, SHORT_CACHE_CONTROL),
        ],
        PATIENT_BROWSER_CONFIG,
    )
}

/// Response-transform middleware. Runs after both the override route and
/// the fallback `ServeDir`:
///
/// - For `patient-browser`, if the path is a *case-variant* of the config
///   key (`CONFIG/Default.json5` etc.), substitutes the committed config
///   so an oddly-cased on-disk file can't shadow the override.
/// - On every successful response, sets `Cache-Control` per [`cache_control_for`].
async fn cache_and_override(req: Request, next: Next) -> Response {
    let app_id = req
        .extensions()
        .get::<AppId>()
        .map(|a| a.0.as_str())
        .unwrap_or("")
        .to_owned();
    let rel_lower = req
        .uri()
        .path()
        .strip_prefix('/')
        .unwrap_or("")
        .to_ascii_lowercase();

    // Override (case-variant guard): a `CONFIG/Default.json5`-style request
    // slipped past axum's exact-match route — substitute the committed
    // config rather than letting ServeDir's on-disk file (or a 404) win.
    if app_id == PATIENT_BROWSER_ID && rel_lower == PATIENT_BROWSER_CONFIG_KEY_LOWER {
        return serve_patient_browser_config_override()
            .await
            .into_response();
    }

    let response = next.run(req).await;
    if response.status() != StatusCode::OK {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control_for(&rel_lower)),
    );
    Response::from_parts(parts, body)
}

/// Cache-Control for a normalized (lowercased) request key. Anything that's
/// an HTML page or sits under a `config/` segment is short-lived (a redeploy
/// can repoint it); fingerprinted bundles (assets, images, fonts) are pinned
/// for a year. Directory-style paths (empty / trailing slash) are HTML too —
/// ServeDir resolves them to `index.html`.
fn cache_control_for(rel_lower: &str) -> &'static str {
    let looks_like_html =
        rel_lower.is_empty() || rel_lower.ends_with('/') || rel_lower.ends_with(".html");
    if looks_like_html || rel_lower.contains("config/") {
        SHORT_CACHE_CONTROL
    } else {
        IMMUTABLE_CACHE_CONTROL
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A throwaway directory under the OS temp dir, cleaned up on drop. Avoids a
    /// `tempfile` dependency for the crate's only filesystem-backed tests.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "vendor-apps-rust-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).expect("create temp root");
            TempRoot(dir)
        }

        fn write(&self, rel: &str, bytes: &[u8]) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().expect("rel has a parent")).expect("mkdir -p");
            std::fs::write(path, bytes).expect("write temp asset");
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn fetch(app_id: &str, root: &TempRoot, path: &str) -> Response {
        setup_installed_app(app_id, root.0.clone())
            .oneshot(
                Request::get(path)
                    .body(Body::empty())
                    .expect("request builds"),
            )
            .await
            .expect("router is infallible")
    }

    fn header_value(res: &Response, name: header::HeaderName) -> String {
        res.headers()
            .get(name)
            .expect("header present")
            .to_str()
            .expect("header is ascii")
            .to_owned()
    }

    #[tokio::test]
    async fn serves_index_html_at_root_with_short_cache_unrebased() {
        let root = TempRoot::new();
        // Upstream patient-browser HTML carries root-absolute URLs
        // (`/assets/...`); at root serving they're already correct, so the
        // body must come through unchanged.
        root.write(
            "index.html",
            b"<!doctype html><script src=\"/assets/app.js\"></script>",
        );
        let res = fetch("patient-browser", &root, "/index.html").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            header_value(&res, header::CONTENT_TYPE).starts_with("text/html"),
            "expected text/html content-type",
        );
        assert_eq!(
            header_value(&res, header::CACHE_CONTROL),
            SHORT_CACHE_CONTROL
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("\"/assets/app.js\""),
            "the HTML must NOT be rebased at root: {text:?}",
        );
    }

    #[tokio::test]
    async fn root_path_serves_index() {
        let root = TempRoot::new();
        root.write("index.html", b"<!doctype html>");
        let res = fetch("patient-browser", &root, "/").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            header_value(&res, header::CONTENT_TYPE).starts_with("text/html"),
            "ServeDir resolves directory paths to index.html",
        );
    }

    #[tokio::test]
    async fn fingerprinted_asset_is_immutable() {
        let root = TempRoot::new();
        root.write("assets/app.js", b"console.log('x')");
        let res = fetch("patient-browser", &root, "/assets/app.js").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            header_value(&res, header::CONTENT_TYPE).starts_with("application/javascript")
                || header_value(&res, header::CONTENT_TYPE).starts_with("text/javascript"),
            "expected a javascript content-type, got {}",
            header_value(&res, header::CONTENT_TYPE),
        );
        assert_eq!(
            header_value(&res, header::CACHE_CONTROL),
            IMMUTABLE_CACHE_CONTROL
        );
    }

    /// The committed SMART config wins over whatever happens to be on disk
    /// at `/config/default.json5`.
    #[tokio::test]
    async fn config_is_served_from_the_committed_override() {
        let root = TempRoot::new();
        root.write("config/default.json5", b"{ \"stale\": true }");
        let res = fetch("patient-browser", &root, "/config/default.json5").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            header_value(&res, header::CACHE_CONTROL),
            SHORT_CACHE_CONTROL
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), PATIENT_BROWSER_CONFIG.as_bytes());
        assert_ne!(body.as_ref(), b"{ \"stale\": true }");
    }

    /// A request for the config path with mixed casing still hits the
    /// committed override — the case-insensitive middleware guard catches
    /// what axum's exact-match route doesn't.
    #[tokio::test]
    async fn case_variant_config_path_still_hits_the_committed_override() {
        let root = TempRoot::new();
        root.write("config/default.json5", b"{ \"stale\": true }");
        let res = fetch("patient-browser", &root, "/Config/Default.JSON5").await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), PATIENT_BROWSER_CONFIG.as_bytes());
    }

    /// The committed override is patient-browser-specific. A different app
    /// id at the same path serves whatever's on disk (or 404s) — the
    /// override is keyed on the id.
    #[tokio::test]
    async fn config_override_does_not_fire_for_other_app_ids() {
        let root = TempRoot::new();
        root.write("config/default.json5", b"{ \"app-y\": true }");
        let res = fetch("app-y", &root, "/config/default.json5").await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            body.as_ref(),
            b"{ \"app-y\": true }",
            "non-patient-browser apps must see the on-disk file, not the override",
        );
    }

    #[tokio::test]
    async fn unknown_asset_is_404() {
        let root = TempRoot::new();
        let res = fetch("patient-browser", &root, "/does-not-exist.js").await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// ServeDir rejects path traversal so a request like `/../etc/passwd`
    /// can never escape the root.
    #[tokio::test]
    async fn path_traversal_is_rejected() {
        let root = TempRoot::new();
        let res = fetch("patient-browser", &root, "/../../etc/passwd").await;
        assert_ne!(
            res.status(),
            StatusCode::OK,
            "ServeDir must not resolve a traversal path",
        );
    }

    #[tokio::test]
    async fn cache_control_policy() {
        assert_eq!(cache_control_for("index.html"), SHORT_CACHE_CONTROL);
        assert_eq!(
            cache_control_for("config/default.json5"),
            SHORT_CACHE_CONTROL
        );
        assert_eq!(cache_control_for("assets/app.js"), IMMUTABLE_CACHE_CONTROL);
        assert_eq!(cache_control_for(""), SHORT_CACHE_CONTROL);
        assert_eq!(cache_control_for("subdir/"), SHORT_CACHE_CONTROL);
    }

    /// `INDEX.HTML` (uppercase) at the root still takes the short cache —
    /// the case-insensitive normalization catches the variant before the
    /// extension check.
    #[tokio::test]
    async fn uppercase_html_extension_still_short_caches() {
        let root = TempRoot::new();
        root.write(
            "INDEX.HTML",
            b"<!doctype html><link href=\"/img/logo.png\">",
        );
        let res = fetch("patient-browser", &root, "/INDEX.HTML").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            header_value(&res, header::CACHE_CONTROL),
            SHORT_CACHE_CONTROL,
            "uppercase .HTML must still take the short cache",
        );
    }
}
