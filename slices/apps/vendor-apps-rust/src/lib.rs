//! Host-side serving of static "installed apps" from a runtime directory.
//!
//! Rather than embedding app files in the binary at build time, this crate
//! serves them from a host-provided directory at request time — so updating an
//! app (or dropping a new one in) needs no recompile. [`setup_vendor_apps`]
//! returns an axum [`Router`] the host merges into its public (unauthenticated)
//! surface; it serves `GET /installed-apps/{*path}` from files under the given
//! `root`.
//!
//! Today the only app is the vendored patient-browser SPA, served under
//! `/installed-apps/patient-browser/`, where the `POST /apps/patient-browser`
//! launch redirect lands. Two patient-browser-specific touches are applied at
//! serve time: its HTML's root-absolute `/assets/`, `/img/`, `/config/` URLs are
//! rebased onto the mount, and `config/default.json5` is served from the
//! committed, version-controlled [`PATIENT_BROWSER_CONFIG`] regardless of what's
//! on disk (so the on-device FHIR URL lives in a readable file, not a brittle
//! rewrite of the upstream build).
//!
//! Static-file delivery (path traversal protection, content-type detection via
//! `mime_guess`, directory→`index.html`) is delegated to
//! [`tower_http::services::ServeDir`]; this module layers the two
//! patient-browser overrides + `Cache-Control` on top.
//!
//! When `root` is absent or empty the routes 404 — a fresh clone or CI serves
//! nothing until the directory is populated (see slices/apps/vendor-apps/README).
//! The crate has no Tauri/GTK dependency, so it compiles in the main Rust CI;
//! only the host that mounts it pulls in Tauri.

use std::path::PathBuf;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;

/// URL mount the installed apps are served under. The catch-all is nested
/// under this prefix; `nest_service` strips it so the inner `ServeDir`
/// resolves the remaining path against the host-provided filesystem root.
const MOUNT: &str = "/installed-apps";

/// Trailing-slashed form of [`MOUNT`], used as the prefix the response-transform
/// middleware strips when figuring out which file the response represents.
const MOUNT_WITH_SLASH: &str = "/installed-apps/";

/// Lowercased path prefix (under the mount) of the vendored patient-browser
/// app — the one app that gets the HTML rebase + committed-config override
/// today. Case-insensitive: `INDEX.HTML` under `Patient-Browser/` still gets
/// rebased so the on-disk casing can't quietly skip the rewrite.
const PATIENT_BROWSER_PREFIX_LOWER: &str = "patient-browser/";

/// Lowercased mount-relative key of the patient-browser SMART config. Matched
/// case-insensitively so e.g. `Config/Default.JSON5` still hits the override.
const PATIENT_BROWSER_CONFIG_KEY_LOWER: &str = "patient-browser/config/default.json5";

/// The committed, version-controlled SMART config for patient-browser. Embedded
/// (it's tiny and authoritative — the on-device FHIR URL + timeout) and served
/// at the patient-browser config path so it survives whatever dist the
/// directory happens to hold.
const PATIENT_BROWSER_CONFIG: &str = include_str!("../patient-browser-config/default.json5");

/// Root-absolute prefixes rewritten in patient-browser HTML to sit under its
/// mount (the upstream build emits `/assets/...`, `/img/...`, `/config/...`).
const REBASE_PREFIXES: [&str; 3] = ["/assets/", "/img/", "/config/"];

/// Fingerprinted bundles (`assets/`, `img/`, fonts) never change for a given
/// build, so they cache for a year. `index.html` and `config/*` are the
/// rotation points a redeploy can repoint, so they stay short-lived with
/// revalidation.
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const SHORT_CACHE_CONTROL: &str = "public, max-age=60, must-revalidate";

/// Upper bound on the size of an HTML file we'll buffer to rebase. A
/// patient-browser index.html is a few hundred bytes plus the inlined
/// `<script>`/`<link>` tags. 1 MiB is two orders of magnitude over that —
/// generous, but not unbounded.
const MAX_HTML_REBASE_BYTES: usize = 1 << 20;

/// Router serving installed-app files from `root` at request time. Merge it into
/// the host's public router. `root` is the directory whose children are app
/// folders (e.g. `root/patient-browser/index.html`); it need not exist yet — a
/// missing file (or missing root) is a plain 404.
pub fn setup_vendor_apps(root: PathBuf) -> Router {
    Router::new()
        // The committed SMART config wins over any on-disk file at this path.
        // Matched as a fixed route (case-sensitive at the axum layer) — the
        // middleware below catches case-variant requests that fall through to
        // ServeDir and 404 / mis-cache.
        .route(
            &format!("{MOUNT_WITH_SLASH}{PATIENT_BROWSER_CONFIG_KEY_LOWER}"),
            get(serve_patient_browser_config_override),
        )
        // Everything else: the host-provided directory, served by ServeDir
        // (traversal protection + mime_guess content types + directory →
        // index.html resolution all handled there, replacing the hand-rolled
        // `safe_join` + MIME table + index fallback this used to carry).
        .nest_service(
            MOUNT,
            ServeDir::new(root).append_index_html_on_directories(true),
        )
        // After the file is fetched: rebase patient-browser HTML, intercept
        // case-variant config-override requests, set Cache-Control. Bracketing
        // the routes via `layer` so it runs for both the override route and
        // the nested ServeDir.
        .layer(middleware::from_fn(rebase_and_cache))
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

/// Response-transform middleware. Runs after both the override route and the
/// nested `ServeDir`:
///
/// - If the path is a *case-variant* of the patient-browser config key
///   (`patient-browser/CONFIG/Default.json5` etc.), substitutes the committed
///   config so an oddly-cased on-disk file can't shadow the override.
/// - On a successful HTML response under `patient-browser/`, rebases the three
///   root-absolute prefixes onto the mount and adjusts `Content-Length`.
/// - On every successful response, sets `Cache-Control` per [`cache_control_for`].
///
/// All path matching is case-insensitive (`INDEX.HTML` / `Patient-Browser/`
/// are handled the same as the lowercase forms).
async fn rebase_and_cache(req: Request, next: Next) -> Response {
    let rel_lower = req
        .uri()
        .path()
        .strip_prefix(MOUNT_WITH_SLASH)
        .unwrap_or("")
        .to_ascii_lowercase();

    // Override 1 (case-variant guard): an INDEX.HTML-style request for the
    // config path slipped past axum's exact-match route — substitute the
    // committed config rather than letting ServeDir's on-disk file (or a 404)
    // win.
    if rel_lower == PATIENT_BROWSER_CONFIG_KEY_LOWER {
        return serve_patient_browser_config_override()
            .await
            .into_response();
    }

    let response = next.run(req).await;
    if response.status() != StatusCode::OK {
        return response;
    }

    let cache_value = cache_control_for(&rel_lower);
    let response_is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().starts_with("text/html"));
    let needs_rebase = response_is_html && rel_lower.starts_with(PATIENT_BROWSER_PREFIX_LOWER);

    let (mut parts, body) = response.into_parts();
    let final_body = if needs_rebase {
        match axum::body::to_bytes(body, MAX_HTML_REBASE_BYTES).await {
            Ok(bytes) => {
                let rebased = rebase_html(&String::from_utf8_lossy(&bytes)).into_bytes();
                parts
                    .headers
                    .insert(header::CONTENT_LENGTH, HeaderValue::from(rebased.len()));
                Body::from(rebased)
            }
            Err(error) => {
                tracing::warn!(%error, "vendor-apps: failed to buffer HTML for rebase, returning 500");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    } else {
        body
    };
    parts
        .headers
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_value));
    Response::from_parts(parts, final_body)
}

/// Rebase the three root-absolute prefixes in a patient-browser HTML document
/// onto its mount (`/installed-apps/patient-browser`).
fn rebase_html(text: &str) -> String {
    let mount = format!(
        "{MOUNT_WITH_SLASH}{}",
        PATIENT_BROWSER_PREFIX_LOWER.trim_end_matches('/')
    );
    let mut out = text.to_owned();
    for prefix in REBASE_PREFIXES {
        out = out.replace(prefix, &format!("{mount}{prefix}"));
    }
    out
}

/// Cache-Control for a normalized (lowercased) request key. Anything that's
/// an HTML page or sits under a `config/` segment is short-lived (a redeploy
/// can repoint it); fingerprinted bundles (assets, images, fonts) are pinned
/// for a year. Directory-style paths (empty / trailing slash) are HTML too —
/// ServeDir resolves them to `index.html`.
fn cache_control_for(rel_lower: &str) -> &'static str {
    let looks_like_html =
        rel_lower.is_empty() || rel_lower.ends_with('/') || rel_lower.ends_with(".html");
    if looks_like_html || rel_lower.contains("/config/") {
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

    async fn fetch(root: &TempRoot, path: &str) -> Response {
        setup_vendor_apps(root.0.clone())
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
    async fn serves_index_html_with_short_cache_and_rebases_urls() {
        let root = TempRoot::new();
        root.write(
            "patient-browser/index.html",
            b"<!doctype html><script src=\"/assets/app.js\"></script>",
        );
        let res = fetch(&root, "/installed-apps/patient-browser/index.html").await;
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
        // The root-absolute `/assets/` URL is rebased onto the mount.
        assert!(
            String::from_utf8_lossy(&body)
                .contains("/installed-apps/patient-browser/assets/app.js"),
            "expected rebased asset URL in {:?}",
            String::from_utf8_lossy(&body),
        );
    }

    #[tokio::test]
    async fn trailing_slash_mount_serves_index() {
        let root = TempRoot::new();
        root.write("patient-browser/index.html", b"<!doctype html>");
        let res = fetch(&root, "/installed-apps/patient-browser/").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            header_value(&res, header::CONTENT_TYPE).starts_with("text/html"),
            "ServeDir resolves directory paths to index.html",
        );
    }

    #[tokio::test]
    async fn fingerprinted_asset_is_immutable() {
        let root = TempRoot::new();
        root.write("patient-browser/assets/app.js", b"console.log('x')");
        let res = fetch(&root, "/installed-apps/patient-browser/assets/app.js").await;
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

    #[tokio::test]
    async fn config_is_served_from_the_committed_override() {
        let root = TempRoot::new();
        // An on-disk config that must NOT be served — the committed one wins.
        root.write(
            "patient-browser/config/default.json5",
            b"{ \"stale\": true }",
        );
        let res = fetch(
            &root,
            "/installed-apps/patient-browser/config/default.json5",
        )
        .await;
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
        root.write(
            "patient-browser/config/default.json5",
            b"{ \"stale\": true }",
        );
        let res = fetch(
            &root,
            "/installed-apps/patient-browser/Config/Default.JSON5",
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), PATIENT_BROWSER_CONFIG.as_bytes());
    }

    #[tokio::test]
    async fn unknown_asset_is_404() {
        let root = TempRoot::new();
        let res = fetch(&root, "/installed-apps/patient-browser/does-not-exist.js").await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// ServeDir rejects path traversal so a request like `/../etc/passwd`
    /// can never escape the root — the responsibility moves from our
    /// `safe_join` to ServeDir's built-in component validation.
    #[tokio::test]
    async fn path_traversal_is_rejected() {
        let root = TempRoot::new();
        let res = fetch(&root, "/installed-apps/patient-browser/../../etc/passwd").await;
        assert_ne!(
            res.status(),
            StatusCode::OK,
            "ServeDir must not resolve a traversal path",
        );
    }

    #[tokio::test]
    async fn cache_control_policy() {
        assert_eq!(
            cache_control_for("patient-browser/index.html"),
            SHORT_CACHE_CONTROL
        );
        assert_eq!(
            cache_control_for("patient-browser/config/default.json5"),
            SHORT_CACHE_CONTROL
        );
        assert_eq!(
            cache_control_for("patient-browser/assets/app.js"),
            IMMUTABLE_CACHE_CONTROL
        );
        assert_eq!(cache_control_for(""), SHORT_CACHE_CONTROL);
        assert_eq!(cache_control_for("patient-browser/"), SHORT_CACHE_CONTROL);
    }

    /// `INDEX.HTML` (uppercase) under an uppercase app folder still gets the
    /// HTML rebase and short cache — the prior implementation's case-sensitive
    /// `ends_with(".html")` would have left these unrewritten and long-cached.
    #[tokio::test]
    async fn uppercase_html_extension_still_rebases_and_short_caches() {
        let root = TempRoot::new();
        root.write(
            "patient-browser/INDEX.HTML",
            b"<!doctype html><link href=\"/img/logo.png\">",
        );
        let res = fetch(&root, "/installed-apps/patient-browser/INDEX.HTML").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            header_value(&res, header::CACHE_CONTROL),
            SHORT_CACHE_CONTROL,
            "uppercase .HTML must still take the short cache",
        );
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert!(
            String::from_utf8_lossy(&body).contains("/installed-apps/patient-browser/img/logo.png"),
            "uppercase .HTML must still get the URL rebase: {:?}",
            String::from_utf8_lossy(&body),
        );
    }
}
