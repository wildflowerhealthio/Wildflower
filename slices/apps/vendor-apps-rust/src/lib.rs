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
//! `/installed-apps/patient-browser/`, where the `GET /apps/patient-browser`
//! launch redirect lands. Two patient-browser-specific touches are applied at
//! serve time: its HTML's root-absolute `/assets/`, `/img/`, `/config/` URLs are
//! rebased onto the mount, and `config/default.json5` is served from the
//! committed, version-controlled [`PATIENT_BROWSER_CONFIG`] regardless of what's
//! on disk (so the on-device FHIR URL lives in a readable file, not a brittle
//! rewrite of the upstream build).
//!
//! When `root` is absent or empty the routes 404 — a fresh clone or CI serves
//! nothing until the directory is populated (see slices/apps/vendor-apps/README).
//! The crate has no Tauri/GTK dependency, so it compiles in the main Rust CI;
//! only the host that mounts it pulls in Tauri.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;

/// URL mount the installed apps are served under. The catch-all route is
/// `"{MOUNT}{*path}"`; a request's captured `{*path}` is normalized and resolved
/// against the host-provided filesystem root.
const MOUNT: &str = "/installed-apps/";

/// Path prefix (under the mount) of the vendored patient-browser app — the one
/// app that gets the HTML rebase + committed-config override today.
const PATIENT_BROWSER_PREFIX: &str = "patient-browser/";

/// Mount-relative key of the patient-browser SMART config. Served from the
/// committed [`PATIENT_BROWSER_CONFIG`], overriding any on-disk copy.
const PATIENT_BROWSER_CONFIG_KEY: &str = "patient-browser/config/default.json5";

/// The committed, version-controlled SMART config for patient-browser. Embedded
/// (it's tiny and authoritative — the on-device FHIR URL + timeout) and served
/// for [`PATIENT_BROWSER_CONFIG_KEY`] so it survives whatever dist the directory
/// happens to hold.
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

/// Router serving installed-app files from `root` at request time. Merge it into
/// the host's public router. `root` is the directory whose children are app
/// folders (e.g. `root/patient-browser/index.html`); it need not exist yet — a
/// missing file (or missing root) is a plain 404.
pub fn setup_vendor_apps(root: PathBuf) -> Router {
    Router::new()
        .route(&format!("{MOUNT}{{*path}}"), get(serve))
        .with_state(Arc::new(root))
}

async fn serve(State(root): State<Arc<PathBuf>>, UrlPath(path): UrlPath<String>) -> Response {
    respond(&root, &path).await
}

/// Resolve a mount-relative request path to a response: the committed config,
/// an on-disk file (HTML rebased), or a 404. Path traversal is rejected by
/// [`safe_join`] before any filesystem access.
async fn respond(root: &Path, raw: &str) -> Response {
    let rel = normalize_rel(raw);

    // The committed SMART config wins over any on-disk file at its key.
    if rel == PATIENT_BROWSER_CONFIG_KEY {
        return ok(
            PATIENT_BROWSER_CONFIG.as_bytes().to_vec(),
            "application/json; charset=utf-8",
            SHORT_CACHE_CONTROL,
        );
    }

    let Some(file) = safe_join(root, &rel) else {
        // `..` / absolute / prefix components — never touch the filesystem.
        return not_found();
    };

    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            // Only patient-browser HTML carries root-absolute URLs that need
            // rebasing onto its mount; serve everything else byte-for-byte.
            let body = if is_html(&rel) && rel.starts_with(PATIENT_BROWSER_PREFIX) {
                rebase_html(&String::from_utf8_lossy(&bytes)).into_bytes()
            } else {
                bytes
            };
            ok(
                body,
                content_type_for(extension(&rel)),
                cache_control_for(&rel),
            )
        }
        Err(_) => not_found(),
    }
}

/// Map a mount-relative request path to an asset key: strip any leading slash,
/// and resolve an empty path or one ending in `/` to that directory's
/// `index.html` (only app roots ship one today).
fn normalize_rel(raw: &str) -> String {
    let trimmed = raw.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.ends_with('/') {
        format!("{trimmed}index.html")
    } else {
        trimmed.to_owned()
    }
}

/// Join `rel` under `root`, accepting only `Normal` path components so the
/// resolved path can never escape `root` (no `..`, no absolute/prefix
/// components). Returns `None` for anything that could traverse out.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return None,
        }
    }
    Some(out)
}

/// Rebase the three root-absolute prefixes in a patient-browser HTML document
/// onto its mount (`/installed-apps/patient-browser`).
fn rebase_html(text: &str) -> String {
    let mount = format!("{MOUNT}{}", PATIENT_BROWSER_PREFIX.trim_end_matches('/'));
    let mut out = text.to_owned();
    for prefix in REBASE_PREFIXES {
        out = out.replace(prefix, &format!("{mount}{prefix}"));
    }
    out
}

fn is_html(rel: &str) -> bool {
    rel.ends_with(".html")
}

/// Lowercased file extension of an asset key, or `""` when it has none (a dot in
/// a directory segment doesn't count).
fn extension(rel: &str) -> String {
    match rel.rsplit_once('.') {
        Some((_, ext)) if !ext.contains('/') => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn content_type_for(ext: String) -> &'static str {
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "json5" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "eot" => "application/vnd.ms-fontobject",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Cache-Control for a normalized asset key (see the cache constants).
fn cache_control_for(rel: &str) -> &'static str {
    if rel.ends_with("index.html") || rel.contains("/config/") {
        SHORT_CACHE_CONTROL
    } else {
        IMMUTABLE_CACHE_CONTROL
    }
}

fn ok(bytes: Vec<u8>, content_type: &str, cache_control: &'static str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(bytes))
        .expect("asset response builds from validated header values")
}

fn not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("Not found"))
        .expect("404 response builds from constant header values")
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

    async fn get(root: &TempRoot, path: &str) -> Response {
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
        let res = get(&root, "/installed-apps/patient-browser/index.html").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            header_value(&res, header::CONTENT_TYPE),
            "text/html; charset=utf-8"
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
        let res = get(&root, "/installed-apps/patient-browser/").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            header_value(&res, header::CONTENT_TYPE),
            "text/html; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn fingerprinted_asset_is_immutable() {
        let root = TempRoot::new();
        root.write("patient-browser/assets/app.js", b"console.log('x')");
        let res = get(&root, "/installed-apps/patient-browser/assets/app.js").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            header_value(&res, header::CONTENT_TYPE),
            "application/javascript; charset=utf-8"
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
        let res = get(
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

    #[tokio::test]
    async fn unknown_asset_is_404() {
        let root = TempRoot::new();
        let res = get(&root, "/installed-apps/patient-browser/does-not-exist.js").await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn safe_join_rejects_traversal_and_absolute_paths() {
        let root = Path::new("/srv/installed-apps");
        assert!(safe_join(root, "patient-browser/index.html").is_some());
        assert!(safe_join(root, "patient-browser/../../etc/passwd").is_none());
        assert!(safe_join(root, "../secret").is_none());
        // A normalized absolute key (leading slash already trimmed by
        // normalize_rel) stays Normal; a raw absolute path is rejected.
        assert!(safe_join(root, "/etc/passwd").is_none());
    }

    #[test]
    fn normalize_rel_maps_empty_and_dir_to_index() {
        assert_eq!(normalize_rel(""), "index.html");
        assert_eq!(
            normalize_rel("patient-browser/"),
            "patient-browser/index.html"
        );
        assert_eq!(
            normalize_rel("patient-browser/assets/app.js"),
            "patient-browser/assets/app.js"
        );
    }

    #[test]
    fn cache_control_policy() {
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
    }

    #[test]
    fn extension_ignores_dots_in_directories() {
        assert_eq!(extension("patient-browser/index.html"), "html");
        assert_eq!(extension("patient-browser/assets/app.JS"), "js");
        assert_eq!(extension("patient-browser/v1.2/app"), "");
    }
}
