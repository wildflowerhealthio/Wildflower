//! Host-side serving of static "installed apps" from a runtime directory.
//! See `slices/apps/self-hosted-apps/README.md` for the design rationale
//! (per-origin isolation, root-serving with no HTML rebase, the committed
//! per-app templates).
//!
//! [`setup_installed_app`] returns the [`Router`] for one app given its id,
//! the on-disk directory holding its files (e.g.
//! `app-data/installed-apps/patient-browser/`), and an [`InstalledAppContext`];
//! the host binds one loopback `TcpListener` per app and `axum::serve`s the
//! router at the root of that origin. A missing or empty directory just 404s.
//! Static-file delivery (path traversal protection, content-type via
//! `mime_guess`, directory → `index.html`) is delegated to
//! [`tower_http::services::ServeDir`].
//!
//! ## Committed templates
//!
//! The `templates/` tree next to this crate is embedded at compile time
//! (`include_dir!`): `templates/<app-id>/<serve-path>.hbs` is rendered with
//! Handlebars per request and served at `/<serve-path>` on that app's origin,
//! winning over any same-path file in the runtime directory. Rendering is
//! per-request because the one template variable, `apiOrigin`, depends on how
//! the caller reached us: a direct loopback caller (the Tauri webview) gets
//! the loopback API origin, while a request forwarded by the trusted front
//! (carrying its `Forwarded` header — see `shared_structures_rust::
//! served_origin`) gets `https://<public_host>` from the tunnel. Today the
//! only template is patient-browser's SMART config at `/config/default.json5`.
//!
//! The crate has no Tauri/GTK dependency, so it compiles in the main Rust CI;
//! only the host that binds the listener pulls in Tauri.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Router};
use handlebars::Handlebars;
use include_dir::{include_dir, Dir};
use shared_structures_rust::served_origin::is_forwarded;
use shared_structures_rust::tunnel_service::TunnelService;
use tower_http::services::ServeDir;
use url::Url;

#[cfg(test)]
use axum::body::Body;

/// The committed per-app template tree, embedded at compile time. Layout:
/// `<app-id>/<serve-path>.hbs` renders at `/<serve-path>` on that app's
/// origin. Adding a template file needs no code change — but does need a
/// Rust rebuild to be embedded.
static TEMPLATES: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/templates");

/// The name of the one variable every template can reference: the API origin
/// (scheme://host[:port], no trailing slash) reachable by the caller.
const API_ORIGIN_VAR: &str = "apiOrigin";

/// Fingerprinted bundles (`assets/`, `img/`, fonts) never change for a given
/// build, so they cache for a year. `index.html` and `config/*` are the
/// rotation points a redeploy can repoint, so they stay short-lived with
/// revalidation. Rendered templates are always short-lived — their content
/// varies with tunnel configuration, so clients must not pin them.
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const SHORT_CACHE_CONTROL: &str = "public, max-age=60, must-revalidate";

/// What the host must supply for per-request template rendering.
#[derive(Clone)]
pub struct InstalledAppContext {
    /// The host's loopback base URL (e.g. `http://127.0.0.1:8080/`). A *loopback*
    /// caller's `apiOrigin` is its origin (`http://127.0.0.1:8080`, no trailing
    /// slash), derived per request rather than pre-stringified so it can't drift.
    pub loopback_base_url: Url,
    /// Supplies the configured public host for *forwarded* callers, so a
    /// browser loading the app through `https://<id>.<public_host>` gets an
    /// `apiOrigin` of `https://<public_host>`.
    pub tunnel: Arc<dyn TunnelService>,
}

/// Everything the render middleware needs, threaded through axum's request
/// extensions so no per-app captured-closure middleware is required. The
/// registry's template names are the app's *lowercased* serve paths, so a
/// case-variant request (`Config/Default.JSON5`) still hits its template.
#[derive(Clone)]
struct TemplateState {
    registry: Arc<Handlebars<'static>>,
    context: InstalledAppContext,
}

/// Router serving one installed app from `app_dir` at the root of its
/// loopback origin. `app_id` selects the committed template subtree
/// (`templates/<app-id>/`) rendered for this app; apps without one are pure
/// static serving.
///
/// `app_dir` is the directory whose children are the app's served files
/// (e.g. `index.html`, `assets/…`); it need not exist yet — a missing file
/// (or missing directory) is a plain 404.
pub fn setup_installed_app(app_id: &str, app_dir: PathBuf, context: InstalledAppContext) -> Router {
    Router::new()
        // Anything without a committed template: the host-provided directory,
        // served at root by ServeDir.
        .fallback_service(ServeDir::new(app_dir).append_index_html_on_directories(true))
        // Render committed templates (winning over same-path disk files,
        // case-insensitively) and set Cache-Control on everything else.
        .layer(middleware::from_fn(render_and_cache))
        .layer(Extension(TemplateState {
            registry: Arc::new(registry_for(app_id)),
            context,
        }))
}

/// Build the Handlebars registry for one app: every `*.hbs` file under
/// `templates/<app-id>/`, registered under its lowercased serve path (the
/// embedded path minus the app prefix and the `.hbs` suffix). Strict mode —
/// a typo'd variable is a render error, not silent empty output — and no
/// HTML escaping, because the outputs are configs, not HTML documents.
///
/// The `expect`s fire only on a malformed *committed* template (non-UTF-8 or
/// bad syntax), which is a build-time asset bug caught by this crate's tests
/// — never on runtime input.
fn registry_for(app_id: &str) -> Handlebars<'static> {
    let mut registry = Handlebars::new();
    registry.set_strict_mode(true);
    registry.register_escape_fn(handlebars::no_escape);
    if let Some(app_templates) = TEMPLATES.get_dir(app_id) {
        register_templates(&mut registry, app_templates, app_id);
    }
    registry
}

/// Recursively register every `*.hbs` file under `dir` (see [`registry_for`]).
fn register_templates(registry: &mut Handlebars<'static>, dir: &Dir<'static>, app_id: &str) {
    for file in dir.files() {
        let Some(serve_path) = file
            .path()
            .to_str()
            .and_then(|path| path.strip_prefix(app_id))
            .and_then(|path| path.strip_prefix('/'))
            .and_then(|path| path.strip_suffix(".hbs"))
        else {
            continue;
        };
        registry
            .register_template_string(
                &serve_path.to_ascii_lowercase(),
                file.contents_utf8().expect("committed template is UTF-8"),
            )
            .expect("committed template parses");
    }
    for subdir in dir.dirs() {
        register_templates(registry, subdir, app_id);
    }
}

/// Response-transform middleware. Runs before the fallback `ServeDir`:
///
/// - If the (lowercased) request path names a committed template for this
///   app, renders and serves it — so a template always wins over a same-path
///   on-disk file, whatever the request's casing.
/// - Otherwise, on every successful response, sets `Cache-Control` per
///   [`cache_control_for`].
async fn render_and_cache(req: Request, next: Next) -> Response {
    let state = req.extensions().get::<TemplateState>().cloned();
    let rel_lower = req
        .uri()
        .path()
        .strip_prefix('/')
        .unwrap_or("")
        .to_ascii_lowercase();

    if let Some(state) = state {
        if state.registry.has_template(&rel_lower) {
            return render_template(&state, &rel_lower, req.headers());
        }
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

/// Render one committed template for one request. The `apiOrigin` variable is
/// the API origin *this caller* can reach:
///
/// - a direct loopback caller (no trusted `Forwarded` header) gets the
///   loopback API origin;
/// - a forwarded caller gets `https://<public_host>` from the tunnel's
///   configured public host. A forwarded request with *no* configured public
///   host shouldn't exist (forwarding runs through the tunnel), but falls
///   back to the loopback origin rather than rendering a broken URL.
///
/// Rendered output takes the short cache: its content varies with tunnel
/// configuration, so clients must revalidate rather than pin it. A render
/// error (e.g. a strict-mode miss on an unknown variable) is logged and
/// answered with an opaque 500.
fn render_template(state: &TemplateState, serve_path_lower: &str, headers: &HeaderMap) -> Response {
    // Derived lazily — only the else-branch (a loopback caller) needs it.
    let make_loopback_origin = || {
        state
            .context
            .loopback_base_url
            .origin()
            .ascii_serialization()
    };
    // Only the forwarded/loopback distinction matters, so `is_forwarded` is the
    // exact fit. A forwarded request with no configured public host 500s rather
    // than falling back to loopback — a remote browser can't reach loopback, and a
    // forwarded request must never be handed the local origin.
    let api_origin = if is_forwarded(headers) {
        let maybe_api_origin = state
            .context
            .tunnel
            .current_public_host()
            .map(|host| format!("https://{host}"));
        let Some(api_origin) = maybe_api_origin else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        api_origin
    } else {
        make_loopback_origin()
    };
    match state.registry.render(
        serve_path_lower,
        &BTreeMap::from([(API_ORIGIN_VAR, api_origin)]),
    ) {
        Ok(body) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type_for(serve_path_lower)),
                (header::CACHE_CONTROL, SHORT_CACHE_CONTROL.to_owned()),
            ],
            body,
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, template = serve_path_lower, "template render failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Content-type for a rendered template, keyed on the serve path's extension.
/// `.json5` isn't in the mime db, so it's pinned to the JSON content-type the
/// former verbatim config override served; everything else goes through
/// `mime_guess` like ServeDir's plain files do.
fn content_type_for(serve_path_lower: &str) -> String {
    if serve_path_lower.ends_with(".json5") {
        return "application/json; charset=utf-8".to_owned();
    }
    mime_guess::from_path(serve_path_lower)
        .first_or_octet_stream()
        .to_string()
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
    use shared_structures_rust::tunnel_service::{
        OfflineTunnel, TunnelLiveness, TunnelService, TunnelStatus,
    };
    use tokio::sync::watch;
    use tower::ServiceExt;

    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    const LOOPBACK_API_ORIGIN: &str = "http://127.0.0.1:8080";
    const PUBLIC_HOST: &str = "demo.example.com";

    /// A tunnel stub with a configured public host — the state a forwarded
    /// request implies. (`OfflineTunnel` covers the no-public-host case.)
    struct PublicHostTunnel;

    #[async_trait::async_trait]
    impl TunnelService for PublicHostTunnel {
        fn current_origin(&self) -> String {
            LOOPBACK_API_ORIGIN.to_owned()
        }
        fn current_public_host(&self) -> Option<String> {
            Some(PUBLIC_HOST.to_owned())
        }
        async fn try_start(&self) -> Result<String, String> {
            Err("unused".to_owned())
        }
        fn subscribe(&self) -> watch::Receiver<TunnelLiveness> {
            watch::channel(TunnelLiveness {
                settings_revision: None,
                status: TunnelStatus::Off,
                origin: self.current_origin(),
                public_host: Some(PUBLIC_HOST.to_owned()),
                error: None,
                dial_attempts: 0,
            })
            .1
        }
    }

    fn context_with_public_host() -> InstalledAppContext {
        InstalledAppContext {
            loopback_base_url: Url::parse(LOOPBACK_API_ORIGIN).expect("valid loopback base url"),
            tunnel: Arc::new(PublicHostTunnel),
        }
    }

    fn context_without_public_host() -> InstalledAppContext {
        InstalledAppContext {
            loopback_base_url: Url::parse(LOOPBACK_API_ORIGIN).expect("valid loopback base url"),
            tunnel: Arc::new(OfflineTunnel::new(LOOPBACK_API_ORIGIN)),
        }
    }

    /// A throwaway directory under the OS temp dir, cleaned up on drop. Avoids a
    /// `tempfile` dependency for the crate's only filesystem-backed tests.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "self-hosted-apps-rust-test-{}-{}",
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

    async fn fetch_with(
        app_id: &str,
        root: &TempRoot,
        request: Request<Body>,
        context: InstalledAppContext,
    ) -> Response {
        setup_installed_app(app_id, root.0.clone(), context)
            .oneshot(request)
            .await
            .expect("router is infallible")
    }

    async fn fetch(app_id: &str, root: &TempRoot, path: &str) -> Response {
        fetch_with(
            app_id,
            root,
            Request::get(path)
                .body(Body::empty())
                .expect("request builds"),
            context_with_public_host(),
        )
        .await
    }

    /// A request carrying the trusted front's `Forwarded` header, the shape
    /// nginx sets before the request enters the tunnel.
    fn forwarded_get(path: &str) -> Request<Body> {
        Request::get(path)
            .header(
                "forwarded",
                format!("for=192.0.2.1;host=patient-browser.{PUBLIC_HOST};proto=https"),
            )
            .body(Body::empty())
            .expect("request builds")
    }

    fn header_value(res: &Response, name: header::HeaderName) -> String {
        res.headers()
            .get(name)
            .expect("header present")
            .to_str()
            .expect("header is ascii")
            .to_owned()
    }

    async fn body_text(res: Response) -> String {
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(body.to_vec()).expect("body is utf-8")
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
        let text = body_text(res).await;
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

    /// The committed SMART config template wins over whatever happens to be on
    /// disk at `/config/default.json5`, and a loopback (unforwarded) request
    /// renders `apiOrigin` as the loopback API origin.
    #[tokio::test]
    async fn config_template_wins_over_disk_and_renders_loopback_origin() {
        let root = TempRoot::new();
        root.write("config/default.json5", b"{ \"stale\": true }");
        let res = fetch("patient-browser", &root, "/config/default.json5").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            header_value(&res, header::CACHE_CONTROL),
            SHORT_CACHE_CONTROL
        );
        assert!(
            header_value(&res, header::CONTENT_TYPE).starts_with("application/json"),
            "rendered json5 keeps the JSON content-type",
        );
        let text = body_text(res).await;
        assert!(
            text.contains(&format!("url: '{LOOPBACK_API_ORIGIN}/fhir-r4'")),
            "loopback caller must get the loopback FHIR URL: {text:?}",
        );
        assert!(
            !text.contains("{{"),
            "no unrendered handlebars expressions may leak: {text:?}",
        );
        assert!(!text.contains("stale"), "the on-disk file must not win");
    }

    /// A forwarded request (trusted front's `Forwarded` header) renders
    /// `apiOrigin` from the tunnel's configured public host — the browser
    /// loading the app remotely must target the public API, not loopback.
    #[tokio::test]
    async fn forwarded_request_renders_public_api_origin() {
        let root = TempRoot::new();
        let res = fetch_with(
            "patient-browser",
            &root,
            forwarded_get("/config/default.json5"),
            context_with_public_host(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        let text = body_text(res).await;
        assert!(
            text.contains(&format!("url: 'https://{PUBLIC_HOST}/fhir-r4'")),
            "forwarded caller must get the public FHIR URL: {text:?}",
        );
    }

    /// A forwarded request with no configured public host (shouldn't happen —
    /// forwarding runs through the tunnel) fails rather than rendering a broken URL.
    #[tokio::test]
    async fn forwarded_request_without_public_host_fails() {
        let root = TempRoot::new();
        let res = fetch_with(
            "patient-browser",
            &root,
            forwarded_get("/config/default.json5"),
            context_without_public_host(),
        )
        .await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A request for the config path with mixed casing still hits the
    /// committed template — the registry keys are lowercased and the
    /// middleware lowercases the request path before the lookup.
    #[tokio::test]
    async fn case_variant_config_path_still_hits_the_template() {
        let root = TempRoot::new();
        root.write("config/default.json5", b"{ \"stale\": true }");
        let res = fetch("patient-browser", &root, "/Config/Default.JSON5").await;
        assert_eq!(res.status(), StatusCode::OK);
        let text = body_text(res).await;
        assert!(
            text.contains(&format!("url: '{LOOPBACK_API_ORIGIN}/fhir-r4'")),
            "case-variant path must still render the template: {text:?}",
        );
    }

    /// Templates are keyed on the app id. A different app id at the same path
    /// serves whatever's on disk (or 404s) — no template subtree, no override.
    #[tokio::test]
    async fn templates_do_not_fire_for_other_app_ids() {
        let root = TempRoot::new();
        root.write("config/default.json5", b"{ \"app-y\": true }");
        let res = fetch("app-y", &root, "/config/default.json5").await;
        assert_eq!(res.status(), StatusCode::OK);
        let text = body_text(res).await;
        assert_eq!(
            text, "{ \"app-y\": true }",
            "non-templated apps must see the on-disk file, not a template",
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

    /// Every committed template parses and renders with the one supported
    /// variable — this is the test backing the `expect`s in [`registry_for`],
    /// and it guards strict-mode misses (a template referencing an unknown
    /// variable fails here, not at runtime).
    #[test]
    fn all_committed_templates_parse_and_render() {
        fn app_ids(dir: &Dir<'static>) -> Vec<String> {
            dir.dirs()
                .filter_map(|d| d.path().file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .collect()
        }
        let ids = app_ids(&TEMPLATES);
        assert!(
            ids.contains(&"patient-browser".to_owned()),
            "the patient-browser template subtree must exist",
        );
        for app_id in ids {
            let registry = registry_for(&app_id);
            let names: Vec<_> = registry.get_templates().keys().cloned().collect();
            assert!(
                !names.is_empty(),
                "app {app_id} has a template dir but no registered templates",
            );
            for name in names {
                let rendered = registry
                    .render(
                        &name,
                        &BTreeMap::from([(API_ORIGIN_VAR, "https://origin.example")]),
                    )
                    .expect("committed template renders with apiOrigin only");
                assert!(
                    !rendered.contains("{{"),
                    "template {name} leaked an unrendered expression",
                );
            }
        }
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
