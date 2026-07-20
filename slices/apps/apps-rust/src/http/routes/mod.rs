//! HTTP routes for the apps slice, grouped into a [`gated_openapi_router`]
//! (list, home-screen, and the per-kind resources) and a [`launch_openapi_router`]
//! (`GET` + `POST /apps/{id}`), merged into [`openapi_router`] for the spec + route
//! tests. The served routes and the OpenAPI spec come from the same
//! `#[utoipa::path]`-annotated handlers. One file per route named by operation,
//! under a folder tree mirroring the URL tree: [`apps`] holds `/apps` (list,
//! launch, delete), [`cloud_apps`] / [`self_hosted_apps`] / [`system_apps`] the
//! per-kind root resources, and [`home_screen`] the flat `/home-screen` route. The
//! gating split is documented on the [`crate::http`] router builders these back.

mod apps;
mod cloud_apps;
mod home_screen;
mod self_hosted_apps;
mod system_apps;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::live_bindings::state::AppsState;

/// The raw request-body cap for `POST /self-hosted-apps` (which accepts a
/// self-hosted upload). Scoped to just that route (the rest of the surface keeps
/// axum's small default), sized to the largest bundle we accept — the 512 MiB
/// *extracted* cap still applies inside the handler.
const UPLOAD_BODY_LIMIT_BYTES: usize = 64 * 1024 * 1024;

/// The scope-gated admin routes as an `OpenApiRouter`, each gated on
/// `wildflower/Apps.{r,c,u,d}` (the spec-bearing inner of
/// [`gated_router`](super::gated_router), which documents the gating split):
///
///  - `GET /apps` (uniform registry list) + `DELETE /apps/{id}` (unified delete) —
///    see [`apps`];
///  - `PUT /home-screen` (atomic reorder / enable, any kind) — see [`home_screen`];
///  - the per-kind root resources `GET`/`POST`/`PUT /cloud-apps…`,
///    `GET`/`POST`/`PUT /self-hosted-apps…`, `GET /system-apps/{id}` — see
///    [`cloud_apps`] / [`self_hosted_apps`] / [`system_apps`].
pub(crate) fn gated_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    // `POST /self-hosted-apps` accepts a self-hosted upload, so its body limit is
    // raised well above axum's small default; building it as its own router and
    // layering the limit there scopes the raise to this one route (a `.layer` on
    // the whole router would loosen every endpoint).
    let upload_router = OpenApiRouter::new()
        .routes(routes!(
            self_hosted_apps::create::handle_create_self_hosted_app
        ))
        .layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT_BYTES));

    OpenApiRouter::new()
        .routes(routes!(apps::list_all::handle_list_apps))
        .routes(routes!(apps::delete_by_id::handle_delete_app))
        .routes(routes!(home_screen::handle_replace_home_screen))
        .routes(routes!(cloud_apps::create::handle_create_cloud_app))
        .routes(routes!(
            cloud_apps::get_by_id::handle_get_cloud_app,
            cloud_apps::update_by_id::handle_update_cloud_app
        ))
        .routes(routes!(
            self_hosted_apps::get_by_id::handle_get_self_hosted_app,
            self_hosted_apps::update_by_id::handle_update_self_hosted_app
        ))
        .routes(routes!(system_apps::get_by_id::handle_get_system_app))
        .merge(upload_router)
}

/// The launch routes (`GET` + `POST /apps/{id}`) as an `OpenApiRouter` — the
/// spec-bearing inner of [`launch_router`](super::launch_router), which documents
/// why they're kept ungated and separate from [`gated_openapi_router`]. `GET` is
/// the native-anchor web arm; `POST` is the typed loopback (Tauri) arm — both
/// share one handler body.
pub(crate) fn launch_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new()
        .routes(routes!(
            apps::launch::handle_launch_app,
            apps::launch::handle_launch_app_get
        ))
        // Bounce a failed *browser* (`GET`) launch to `/home?launchError=<kind>`
        // rather than rendering its raw error body as a page; the typed `POST` arm
        // (which decodes the JSON) is left untouched. Scoped to the launch routes
        // only — a `.layer` here survives the merge into `openapi_router` without
        // touching the gated surface (mirrors the `upload_router` body limit).
        .layer(axum::middleware::from_fn(
            apps::launch::redirect_browser_launch_errors,
        ))
}

/// The full apps surface (gated routes + launch) as one `OpenApiRouter`. Backs
/// [`openapi_spec`](super::openapi_spec) — the committed snapshot and the host's
/// unified `/docs`. The host mounts the two halves separately (via
/// [`gated_openapi_router`] / [`launch_openapi_router`]) so it can gate them
/// differently; this combined form exists only to document the whole surface.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    gated_openapi_router().merge(launch_openapi_router())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use shared_structures_rust::test_utils::RecordingStubWebviewHandle;
    use shared_structures_rust::OnDeviceWebviewHandle;
    use tower::ServiceExt;

    // The port trait is in scope so the concrete store's `insert_cloud_app` /
    // `insert_self_hosted_app` / `find_app` methods resolve in the fixtures.
    use crate::domain::{
        AppKind, AppRegistration, AppUrl, AppsStore, CloudAppConfiguration,
        SelfHostedAppConfigurationPayload,
    };
    use crate::http::test_support::{
        state, state_with_launch_cookies, state_with_launch_scopes, state_with_sink,
        state_with_tunnel, state_with_tunnel_and_handle, tunnel_at, tunnel_unavailable,
        tunnel_with_public_host, FixedLaunchScopes, RecordingLaunchCookies, SENTINEL_SET_COOKIE,
    };
    use crate::live_bindings::state::AppsState;
    use crate::ports::LaunchCookies;
    use scope_capabilities_rust::ScopeClaims;

    /// The owner-level scope claim the host's bearer gate would insert for the
    /// device owner — `wildflower/*.cruds` covers every `wildflower/Apps.<perm>` the
    /// admin capabilities gate on, and the `wildflower/launch` known scope (NOT
    /// covered by the `wildflower/*` wildcard) satisfies the launch umbrella. Every
    /// request below carries it (via [`send`] / [`send_raw`]) so the handlers'
    /// `Scoped<…>` extractors pass; the focused scope tests use [`send_scoped`] to
    /// vary it.
    const OWNER_SCOPES: &str = "wildflower/*.cruds wildflower/launch";

    /// The served router (state applied per-call). Spec half of
    /// `split_for_parts` is irrelevant in the handler tests.
    fn router() -> Router<Arc<AppsState>> {
        super::openapi_router().split_for_parts().0
    }

    /// Insert the `ScopeClaims` the host's bearer gate would place in the request
    /// extensions before a `Scoped<…>` admin handler reads them — modelling the
    /// authN layer's half of the claims-inserting pair. `None` models a request
    /// that reached a gated handler with no scope claim at all.
    fn with_claims(mut req: Request<Body>, scopes: Option<&str>) -> Request<Body> {
        req.extensions_mut()
            .insert(ScopeClaims::new(scopes.map(str::to_owned)));
        req
    }

    async fn send(state: &Arc<AppsState>, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        send_scoped(state, req, Some(OWNER_SCOPES)).await
    }

    /// [`send`] with a caller-chosen scope claim — the focused 403 tests drive an
    /// under-scoped (or absent) claim through the same gated handlers.
    async fn send_scoped(
        state: &Arc<AppsState>,
        req: Request<Body>,
        scopes: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let res = router()
            .with_state(Arc::clone(state))
            .oneshot(with_claims(req, scopes))
            .await
            .expect("oneshot");
        let status = res.status();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    async fn send_raw(state: &Arc<AppsState>, req: Request<Body>) -> axum::response::Response {
        send_raw_scoped(state, req, Some(OWNER_SCOPES)).await
    }

    /// [`send_raw`] with a caller-chosen scope claim — the focused launch-scope
    /// tests drive an under-scoped (or absent) claim through the gated launch arm.
    async fn send_raw_scoped(
        state: &Arc<AppsState>,
        req: Request<Body>,
        scopes: Option<&str>,
    ) -> axum::response::Response {
        router()
            .with_state(Arc::clone(state))
            .oneshot(with_claims(req, scopes))
            .await
            .expect("oneshot")
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    /// A loopback launch — `POST /apps/{id}`, no `Forwarded` header.
    fn post_launch(uri: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    /// A launch as the trusted front would relay it — carries the `Forwarded`
    /// header with the public host/proto (reads as a remote caller).
    fn post_forwarded(uri: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(
                "forwarded",
                "for=192.0.2.1;host=demo.example.com;proto=https",
            )
            .body(Body::empty())
            .unwrap()
    }

    /// A loopback launch via the web arm's `GET` — `GET /apps/{id}`, no
    /// `Forwarded` header (a plain `<a>` click the browser followed).
    fn get_launch(uri: &str) -> Request<Body> {
        get(uri)
    }

    /// A `GET` launch as the trusted front would relay it — the web arm reaching
    /// the server through the front (carries the `Forwarded` header).
    fn get_forwarded(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(
                "forwarded",
                "for=192.0.2.1;host=demo.example.com;proto=https",
            )
            .body(Body::empty())
            .unwrap()
    }

    /// Decode the base64 `launchError` param a browser-launch redirect carries into
    /// the JSON error body the SPA banner reads.
    fn launch_error_body(location: &str) -> serde_json::Value {
        use base64::Engine as _;
        let encoded = location
            .strip_prefix("/home?launchError=")
            .expect("a /home?launchError= redirect");
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .expect("valid URL-safe base64");
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn put_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn delete(uri: &str) -> Request<Body> {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    /// Build a `multipart/form-data` POST with text fields and an optional file
    /// part — the shape `POST /self-hosted-apps` takes.
    fn post_multipart(
        uri: &str,
        fields: &[(&str, &str)],
        file: Option<(&str, &[u8])>,
    ) -> Request<Body> {
        let boundary = "TESTBOUNDARY";
        let mut body: Vec<u8> = Vec::new();
        for (key, value) in fields {
            body.extend_from_slice(
                format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n")
                    .as_bytes(),
            );
        }
        if let Some((key, contents)) = file {
            body.extend_from_slice(
                format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; filename=\"bundle.zip\"\r\nContent-Type: application/zip\r\n\r\n")
                    .as_bytes(),
            );
            body.extend_from_slice(contents);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap()
    }

    /// A cloud create — `POST /cloud-apps` JSON.
    fn post_create_cloud(name: &str, url: &str, requires_tunnel: bool) -> Request<Body> {
        post_json(
            "/cloud-apps",
            serde_json::json!({ "name": name, "url": url, "requiresTunnel": requires_tunnel }),
        )
    }

    /// Seed a cloud app directly through the store (the fixture shortcut a test uses
    /// instead of driving `POST /cloud-apps`).
    fn seed_cloud(store: &crate::db::SqliteAppsStore, id: &str, url: AppUrl) {
        let registration = AppRegistration {
            id: id.to_owned(),
            kind: AppKind::Cloud,
            position: 0,
            on_homescreen: true,
            name: id.to_owned(),
            subtitle: None,
            local_only: false,
            client_id: None,
            requires_tunnel: false,
        };
        store
            .insert_cloud_app(&registration, &CloudAppConfiguration { url })
            .unwrap()
            .expect("inserted");
    }

    /// Seed a self-hosted app directly through the store (the fixture shortcut a test
    /// uses instead of driving `POST /self-hosted-apps`).
    fn seed_self_hosted(
        store: &crate::db::SqliteAppsStore,
        name: &str,
        slug: &str,
        launch_path: Option<&str>,
    ) {
        let registration = AppRegistration {
            id: slug.to_owned(),
            kind: AppKind::SelfHosted,
            position: 0,
            on_homescreen: true,
            name: name.to_owned(),
            subtitle: None,
            local_only: true,
            client_id: None,
            requires_tunnel: false,
        };
        let create = SelfHostedAppConfigurationPayload {
            content_folder: format!("{slug}-folder"),
            subdomain: slug.to_owned(),
            launch_path: launch_path.map(str::to_owned),
        };
        store
            .insert_self_hosted_app(&registration, &create, &[])
            .expect("inserted");
    }

    #[tokio::test]
    async fn list_apps_returns_all_seeded_apps_in_order() {
        let st = state();
        let (status, body) = send(&st, get("/apps")).await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<&str> = body
            .as_array()
            .expect("array")
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![
                "patient-browser",
                "api-view",
                "api-docs",
                "growth-chart",
                "medication-viewer",
                "precise-hbr",
            ],
        );
    }

    /// The list is a uniform `AppRegistration[]` keyed on `kind`: every item
    /// carries the shared facts, and the per-kind payload (`url`, `launchPath`)
    /// stays off the list — it's an editor concern read on a detail lookup.
    #[tokio::test]
    async fn list_apps_is_a_uniform_registration_with_kind() {
        let st = state();
        let (_status, body) = send(&st, get("/apps")).await;
        let arr = body.as_array().unwrap();
        let growth = arr.iter().find(|v| v["id"] == "growth-chart").unwrap();
        assert_eq!(growth["kind"], "cloud");
        assert_eq!(growth["isSmart"], true);
        assert_eq!(growth["requiresTunnel"], true);
        assert_eq!(growth["localOnly"], false);
        assert!(
            growth.get("url").is_none(),
            "the list carries no payload url: {growth}"
        );
        assert!(
            growth.get("isRemovable").is_none(),
            "removable is an editor concern"
        );

        let api_view = arr.iter().find(|v| v["id"] == "api-view").unwrap();
        assert_eq!(api_view["kind"], "system");
        assert_eq!(api_view["localOnly"], true);
        assert_eq!(api_view["isSmart"], false);
        assert_eq!(api_view["requiresTunnel"], false);
    }

    #[tokio::test]
    async fn launch_unknown_id_is_404() {
        let st = state();
        let (status, body) = send(&st, post_launch("/apps/no-such-thing")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A launch whose caller lacks the `wildflower/launch` umbrella is `403` (the
    /// `Scoped<AppLauncher>` extractor), and opens no popup. The umbrella is a
    /// *known* scope, so the owner's `wildflower/*.cruds` alone does NOT cover it.
    #[tokio::test]
    async fn loopback_launch_without_umbrella_scope_is_403() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        let res = send_raw_scoped(
            &st,
            post_launch("/apps/api-docs"),
            Some("wildflower/*.cruds"),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(
            handle.0.lock().expect("handle mutex").is_empty(),
            "an under-scoped launch opens no popup",
        );
    }

    /// The umbrella gate runs *before* any lookup or side-effect: an under-scoped
    /// caller `403`s without triggering the tunnel or revealing existence (an
    /// unknown id is `403`, not `404`).
    #[tokio::test]
    async fn umbrella_gate_precedes_lookup_and_side_effects() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);

        // A requires_tunnel app: 403 before the (would-be) 503 tunnel probe.
        let res = send_raw_scoped(&st, post_launch("/apps/growth-chart"), None).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(
            handle.0.lock().expect("handle mutex").is_empty(),
            "an under-scoped caller opens no popup and probes no tunnel",
        );

        // An unknown id under-scoped → 403, not 404 (no existence leak).
        let res = send_raw_scoped(&st, post_launch("/apps/no-such-thing"), None).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    /// A forwarded launch is gated on the umbrella too (the host wraps the launch
    /// router with the same bearer gate): with the scope it 302s, without it 403s —
    /// the front no longer bypasses authorization.
    #[tokio::test]
    async fn forwarded_launch_requires_the_umbrella_scope() {
        let st = state();
        let ok = send_raw(&st, post_forwarded("/apps/api-docs")).await;
        assert_eq!(ok.status(), StatusCode::FOUND);

        let denied = send_raw_scoped(
            &st,
            post_forwarded("/apps/api-docs"),
            Some("wildflower/*.cruds"),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    /// A forwarded `GET` of a self-hosted app 302s to the public subdomain.
    #[tokio::test]
    async fn get_launch_forwarded_redirects_to_subdomain() {
        let st = state_with_tunnel(tunnel_with_public_host("demo.example.com"));
        let res = send_raw(&st, get_forwarded("/apps/patient-browser")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res.headers().get("location").unwrap().to_str().unwrap();
        assert_eq!(location, "https://patient-browser.demo.example.com/");
    }

    /// A forwarded `GET` (browser) without the umbrella scope bounces to the banner
    /// too (`303` → `/home?launchError=forbidden`), like the loopback `GET` — both
    /// browser arms redirect rather than paint a raw `403`. (The umbrella gate still
    /// runs; only the failed response's *shape* changes.)
    #[tokio::test]
    async fn get_launch_forwarded_without_umbrella_redirects_home() {
        let st = state();
        let denied = send_raw_scoped(
            &st,
            get_forwarded("/apps/api-docs"),
            Some("wildflower/*.cruds"),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::SEE_OTHER);
        let body = launch_error_body(denied.headers().get("location").unwrap().to_str().unwrap());
        assert_eq!(body["error"], "InsufficientScope");
    }

    /// A loopback `GET` (browser) without the umbrella scope bounces to the
    /// home-screen banner — a `303` to `/home?launchError=forbidden` — not a raw
    /// `403` page. (The typed `POST` arm still `403`s: see
    /// `loopback_launch_without_umbrella_scope_is_403`.)
    #[tokio::test]
    async fn get_launch_loopback_without_umbrella_redirects_home() {
        let st = state();
        let res = send_raw_scoped(
            &st,
            get_launch("/apps/api-docs"),
            Some("wildflower/*.cruds"),
        )
        .await;
        assert_eq!(res.status(), StatusCode::SEE_OTHER);
        // The base64 body is the `InsufficientScope` the extractor returned, so the
        // SPA banner can name the missing scopes.
        let body = launch_error_body(res.headers().get("location").unwrap().to_str().unwrap());
        assert_eq!(body["error"], "InsufficientScope");
    }

    /// Seed a **SMART** cloud app (a `client_id` present) that launches against the
    /// loopback origin — the fixture the per-app SMART launch tests drive.
    fn seed_smart_cloud(store: &crate::db::SqliteAppsStore, id: &str) {
        let registration = AppRegistration {
            id: id.to_owned(),
            kind: AppKind::Cloud,
            position: 0,
            on_homescreen: true,
            name: id.to_owned(),
            subtitle: None,
            local_only: false,
            client_id: Some("client-1".to_owned()),
            requires_tunnel: false,
        };
        store
            .insert_cloud_app(
                &registration,
                &CloudAppConfiguration {
                    url: AppUrl::OriginRelative("/smart".to_owned()),
                },
            )
            .unwrap()
            .expect("inserted");
    }

    /// A SMART app launch additionally requires the caller's grant to cover its
    /// client's scopes: a covering caller launches (`204`). `patient/Observation.rs`
    /// (read+search) covers the required `.r` (read).
    #[tokio::test]
    async fn launch_smart_app_covering_client_scopes_succeeds() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_launch_scopes(
            Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>,
            FixedLaunchScopes::requiring("patient/Observation.r"),
        );
        seed_smart_cloud(&st.store, "smart-app");
        let res = send_raw_scoped(
            &st,
            post_launch("/apps/smart-app"),
            Some("wildflower/launch patient/Observation.rs"),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    /// An under-scoped SMART launch (umbrella held, client scope not) is
    /// `403 InsufficientScope` naming the gap — the loopback/SPA arm decodes JSON,
    /// and no popup opens.
    #[tokio::test]
    async fn launch_smart_app_under_scoped_loopback_is_403_json() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_launch_scopes(
            Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>,
            FixedLaunchScopes::requiring("patient/Observation.r"),
        );
        seed_smart_cloud(&st.store, "smart-app");
        let (status, body) = send_scoped(
            &st,
            post_launch("/apps/smart-app"),
            Some("wildflower/launch"),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "InsufficientScope");
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["patient/Observation.r"])
        );
        assert!(handle.0.lock().expect("handle mutex").is_empty());
    }

    /// A forwarded (browser-navigation) under-scoped SMART launch renders a plain
    /// `text/plain` 403 — not the JSON body the SPA decodes.
    #[tokio::test]
    async fn launch_smart_app_under_scoped_forwarded_is_plain_403() {
        let st = state_with_launch_scopes(
            Arc::new(RecordingStubWebviewHandle::default()) as Arc<dyn OnDeviceWebviewHandle>,
            FixedLaunchScopes::requiring("patient/Observation.r"),
        );
        seed_smart_cloud(&st.store, "smart-app");
        let res = send_raw_scoped(
            &st,
            post_forwarded("/apps/smart-app"),
            Some("wildflower/launch"),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let content_type = res.headers().get("content-type").unwrap().to_str().unwrap();
        assert!(
            content_type.starts_with("text/plain"),
            "the browser arm gets a plain 403, not JSON: {content_type}",
        );
    }

    /// A non-SMART app ignores the launch-scopes port entirely: even with a port
    /// requiring a scope the caller lacks, a system app launches (the SMART check
    /// short-circuits on `is_smart() == false`).
    #[tokio::test]
    async fn launch_non_smart_app_ignores_the_launch_scopes_port() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_launch_scopes(
            Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>,
            FixedLaunchScopes::requiring("patient/Observation.r"),
        );
        // api-docs is a seeded SYSTEM app (non-SMART).
        let res = send_raw_scoped(
            &st,
            post_launch("/apps/api-docs"),
            Some("wildflower/launch"),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    /// A loopback `GET` of a system app 204s after handing the URL to the host sink.
    #[tokio::test]
    async fn get_launch_loopback_opens_the_host_sink() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        let res = send_raw(&st, get_launch("/apps/api-docs")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let opened = handle.0.lock().expect("handle mutex").clone();
        assert_eq!(opened, vec!["http://127.0.0.1:8080/docs".to_string()]);
    }

    /// A `GET` (browser) launch of an unknown id bounces to the banner
    /// (`303` → `/home?launchError=not-found`) rather than a raw `404` page; the
    /// typed `POST` arm still `404`s with JSON (`launch_unknown_id_is_404`).
    #[tokio::test]
    async fn get_launch_unknown_id_redirects_home() {
        let st = state();
        let res = send_raw(&st, get_launch("/apps/no-such-thing")).await;
        assert_eq!(res.status(), StatusCode::SEE_OTHER);
        let body = launch_error_body(res.headers().get("location").unwrap().to_str().unwrap());
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A `GET` (browser) launch with no reachable target (a forwarded self-hosted
    /// launch with no public host — a `503`) bounces to
    /// `/home?launchError=unavailable`.
    #[tokio::test]
    async fn get_launch_unavailable_redirects_home() {
        let st = state();
        let res = send_raw(&st, get_forwarded("/apps/patient-browser")).await;
        assert_eq!(res.status(), StatusCode::SEE_OTHER);
        let body = launch_error_body(res.headers().get("location").unwrap().to_str().unwrap());
        assert_eq!(body["error"], "LaunchUnavailable");
    }

    /// A system app launches via its stored source URL, resolved against the
    /// loopback origin for a local caller.
    #[tokio::test]
    async fn launch_system_app_resolves_stored_url() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        let res = send_raw(&st, post_launch("/apps/api-docs")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let opened = handle.0.lock().expect("handle mutex").clone();
        assert_eq!(opened, vec!["http://127.0.0.1:8080/docs".to_string()]);
    }

    /// A registration whose child payload row is missing (raw SQL tampering) is a
    /// corrupt registry — the launch read fails as a logged 500 (never a panic).
    #[tokio::test]
    async fn launch_registration_missing_child_is_500() {
        use diesel::prelude::*;

        let st = state();
        let mut conn = st.store.pool().get().unwrap();
        diesel::sql_query(
            "INSERT INTO app_registrations (id, kind, position, on_homescreen, name, local_only, requires_tunnel) \
             VALUES ('ghost-system', 'system', 99, 1, 'Ghost', 1, 0)",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        let res = send_raw(&st, post_launch("/apps/ghost-system")).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A forwarded launch of a self-hosted app with `public_host` redirects to the
    /// public subdomain.
    #[tokio::test]
    async fn launch_self_hosted_forwarded_redirects_to_subdomain() {
        let st = state_with_tunnel(tunnel_with_public_host("demo.example.com"));
        let res = send_raw(&st, post_forwarded("/apps/patient-browser")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res.headers().get("location").unwrap().to_str().unwrap();
        assert_eq!(location, "https://patient-browser.demo.example.com/");
    }

    /// A forwarded self-hosted launch plants the re-scoped owner session.
    #[tokio::test]
    async fn launch_self_hosted_forwarded_plants_rescoped_session_cookie() {
        let recorder = Arc::new(RecordingLaunchCookies::default());
        let st = state_with_launch_cookies(
            tunnel_with_public_host("demo.example.com"),
            Arc::clone(&recorder) as Arc<dyn LaunchCookies>,
        );
        let res = send_raw(&st, post_forwarded("/apps/patient-browser")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        assert_eq!(
            res.headers().get("location").unwrap().to_str().unwrap(),
            "https://patient-browser.demo.example.com/",
        );
        let cookies: Vec<&str> = res
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(cookies, vec![SENTINEL_SET_COOKIE]);
        assert_eq!(
            *recorder.hosts.lock().unwrap(),
            vec!["demo.example.com".to_string()],
            "the seam is scoped to the public host that built the subdomain URL",
        );
    }

    /// A forwarded *cloud* launch plants no session cookie.
    #[tokio::test]
    async fn launch_cloud_forwarded_plants_no_session_cookie() {
        let recorder = Arc::new(RecordingLaunchCookies::default());
        let st = state_with_launch_cookies(
            tunnel_with_public_host("demo.example.com"),
            Arc::clone(&recorder) as Arc<dyn LaunchCookies>,
        );
        seed_cloud(&st.store, "app-y", AppUrl::OriginRelative("/y".to_owned()));
        let res = send_raw(&st, post_forwarded("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        assert!(res.headers().get("set-cookie").is_none());
        assert!(recorder.hosts.lock().unwrap().is_empty());
    }

    /// A *loopback* self-hosted launch plants no session cookie.
    #[tokio::test]
    async fn launch_self_hosted_loopback_plants_no_session_cookie() {
        let recorder = Arc::new(RecordingLaunchCookies::default());
        let st = state_with_launch_cookies(
            tunnel_with_public_host("demo.example.com"),
            Arc::clone(&recorder) as Arc<dyn LaunchCookies>,
        );
        let res = send_raw(&st, post_launch("/apps/patient-browser")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(res.headers().get("set-cookie").is_none());
        assert!(recorder.hosts.lock().unwrap().is_empty());
    }

    /// A forwarded self-hosted launch with no `public_host` is 503.
    #[tokio::test]
    async fn launch_self_hosted_forwarded_without_public_host_is_503() {
        let st = state();
        let (status, body) = send(&st, post_forwarded("/apps/patient-browser")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"], "LaunchUnavailable");
    }

    /// A loopback self-hosted launch 204s with its fixed loopback origin.
    #[tokio::test]
    async fn launch_self_hosted_loopback_204s_to_its_origin() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        let res = send_raw(&st, post_launch("/apps/patient-browser")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(res.headers().get("location").is_none());
        let opened = handle.0.lock().expect("handle mutex").clone();
        assert_eq!(opened, vec!["http://127.0.0.1:8081/".to_string()]);
    }

    /// A cloud `requires_tunnel` launch with the tunnel down is 503; no popup.
    #[tokio::test]
    async fn launch_cloud_requires_tunnel_with_tunnel_down_is_503() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_tunnel_and_handle(
            tunnel_unavailable(),
            Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>,
        );
        let (status, body) = send(&st, post_launch("/apps/growth-chart")).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"], "LaunchUnavailable");
        assert!(handle.0.lock().expect("handle mutex").is_empty());
    }

    /// A cloud `requires_tunnel` launch resolves to the verified tunnel origin.
    #[tokio::test]
    async fn launch_cloud_resolves_to_the_verified_tunnel_origin() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_tunnel_and_handle(
            tunnel_at("https://dev1.example.com"),
            Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>,
        );
        let res = send_raw(&st, post_launch("/apps/growth-chart")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let opened = handle.0.lock().expect("handle mutex").clone();
        let [url] = opened.as_slice() else {
            panic!("exactly one URL, got {opened:?}");
        };
        assert!(
            url.contains("iss=https://dev1.example.com/fhir-r4"),
            "expected the verified tunnel origin in {url}",
        );
    }

    /// A created (non-tunnel) cloud app launches against the loopback origin.
    #[tokio::test]
    async fn launch_cloud_origin_relative_resolves_against_loopback() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        seed_cloud(&st.store, "app-y", AppUrl::OriginRelative("/y".to_owned()));
        let res = send_raw(&st, post_launch("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            handle.0.lock().expect("handle mutex").clone(),
            vec!["http://127.0.0.1:8080/y".to_string()],
        );
    }

    /// A forwarded cloud launch resolves `{origin}` against the served origin.
    #[tokio::test]
    async fn launch_cloud_forwarded_uses_served_origin_and_302s() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        seed_cloud(&st.store, "app-y", AppUrl::OriginRelative("/y".to_owned()));
        let res = send_raw(&st, post_forwarded("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res.headers().get("location").unwrap().to_str().unwrap();
        assert_eq!(location, "https://demo.example.com/y");
        assert!(handle.0.lock().expect("handle mutex").is_empty());
    }

    /// A cloud row whose stored url no longer parses fails the typed read → 500.
    #[tokio::test]
    async fn launch_rejects_unparseable_stored_cloud_url_as_500() {
        use diesel::prelude::*;

        let st = state();
        let mut conn = st.store.pool().get().unwrap();
        diesel::sql_query(
            "UPDATE cloud_app_configurations SET url = 'http://evil.example.com' WHERE id = 'growth-chart'",
        )
        .execute(&mut conn)
        .unwrap();
        // growth-chart requires the tunnel; drop requires_tunnel (now on the parent)
        // so the launch reaches the url read rather than 503-ing on the down tunnel.
        diesel::sql_query(
            "UPDATE app_registrations SET requires_tunnel = 0 WHERE id = 'growth-chart'",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        let res = send_raw(&st, post_launch("/apps/growth-chart")).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn full_round_trip_create_update_delete() {
        let st = state();
        let (status, body) = send(
            &st,
            post_create_cloud("My App", "https://example.com/launch", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["kind"], "cloud");
        assert!(body["onHomescreen"].as_bool().unwrap());
        assert_eq!(body["isRemovable"], true);
        let id = body["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let (status, body) = send(
            &st,
            put_json(
                &format!("/cloud-apps/{id}"),
                serde_json::json!({
                    "name": "Renamed",
                    "url": "https://example.com/launch",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");
        assert_eq!(body["kind"], "cloud");

        let res = send_raw(&st, delete(&format!("/apps/{id}"))).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(st.store.find_app(&id).unwrap().is_none());
    }

    #[tokio::test]
    async fn create_rejects_bad_url_and_empty_name() {
        let st = state();
        let (status, body) =
            send(&st, post_create_cloud("Bad", "javascript:alert(1)", false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");

        let (status, body) = send(&st, post_create_cloud("", "https://example.com/x", false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidName");
    }

    /// The per-kind write/detail paths 404 on an id of another kind (the mismatch
    /// can no longer be expressed as a 409), 409 on a seeded self-hosted edit, and
    /// 404 on an unknown id. Delete of a system / seeded app is 409.
    #[tokio::test]
    async fn per_kind_paths_reject_wrong_kind_and_unknown() {
        let st = state();

        // A cloud path given a system / self-hosted id is a 404.
        for id in ["api-docs", "patient-browser"] {
            let (status, body) = send(
                &st,
                put_json(
                    &format!("/cloud-apps/{id}"),
                    serde_json::json!({ "name": "x", "url": "https://example.com/x", "requiresTunnel": false }),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{id} cloud replace");
            assert_eq!(body["error"], "AppNotFound");

            let (status, _) = send(&st, get(&format!("/cloud-apps/{id}"))).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{id} cloud detail");
        }

        // A self-hosted path to a seeded app is a 409; to a cloud id a 404.
        let (status, body) = send(
            &st,
            put_json(
                "/self-hosted-apps/patient-browser",
                serde_json::json!({ "launchPath": "/launch.html" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "seeded self-hosted edit");
        assert_eq!(body["error"], "AppNotEditable");

        let (status, _) = send(
            &st,
            put_json(
                "/self-hosted-apps/growth-chart",
                serde_json::json!({ "launchPath": "/launch.html" }),
            ),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "self-hosted path to a cloud id"
        );

        // Delete of a system / seeded app is a 409; unknown id a 404.
        for id in ["api-docs", "patient-browser"] {
            let (status, body) = send(&st, delete(&format!("/apps/{id}"))).await;
            assert_eq!(status, StatusCode::CONFLICT, "{id} delete");
            assert_eq!(body["error"], "AppNotEditable");
        }

        let (status, body) = send(
            &st,
            put_json(
                "/cloud-apps/no-such-id",
                serde_json::json!({ "name": "x", "url": "https://example.com/x", "requiresTunnel": false }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");

        let (status, body) = send(&st, delete("/apps/no-such-id")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A seeded cloud app's content is replaceable through `/cloud-apps/{id}`, and
    /// the response carries the new `url`; it's deletable via the unified path.
    #[tokio::test]
    async fn seeded_cloud_app_can_be_edited_and_deleted() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/cloud-apps/growth-chart",
                serde_json::json!({ "name": "Renamed", "url": "https://example.com/x", "requiresTunnel": true }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");
        assert_eq!(body["kind"], "cloud");
        assert_eq!(body["url"], "https://example.com/x");
        assert_eq!(body["requiresTunnel"], true);

        let res = send_raw(&st, delete("/apps/growth-chart")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    /// A cloud detail read carries the stored url template + `removable: true`; a
    /// system detail is read-only (no `removable`).
    #[tokio::test]
    async fn per_kind_detail_reads_carry_payload_and_removable() {
        let st = state();

        let (status, body) = send(&st, get("/cloud-apps/growth-chart")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["kind"], "cloud");
        assert_eq!(body["isRemovable"], true);
        assert!(body["url"].as_str().unwrap().contains("{origin}"));

        let (status, body) = send(&st, get("/self-hosted-apps/patient-browser")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["kind"], "self-hosted");
        assert_eq!(body["seeded"], true);
        assert_eq!(body["isRemovable"], false);

        let (status, body) = send(&st, get("/system-apps/api-docs")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["kind"], "system");
        assert_eq!(body["url"], "{origin}/docs");
        assert!(
            body.get("isRemovable").is_none(),
            "system detail has no removable"
        );
    }

    /// Editability resolves before field validation: a cloud-body PUT to a system
    /// id is `404` (not a cloud app), even though its url is also bad.
    #[tokio::test]
    async fn cloud_replace_of_system_id_with_bad_url_is_404() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/cloud-apps/api-docs",
                serde_json::json!({ "name": "x", "url": "javascript:alert(1)", "requiresTunnel": false }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A self-hosted app's launch path is editable through `/self-hosted-apps/{id}`.
    #[tokio::test]
    async fn replace_self_hosted_launch_path_edits_and_launches() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        seed_self_hosted(&st.store, "My App", "my-app", None);

        let (status, body) = send(
            &st,
            put_json(
                "/self-hosted-apps/my-app",
                serde_json::json!({ "launchPath": "/launch.html?launch={launch}&iss={origin}/fhir-r4" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["kind"], "self-hosted");
        assert_eq!(body["isRemovable"], true);
        assert_eq!(
            body["launchPath"],
            "/launch.html?launch={launch}&iss={origin}/fhir-r4"
        );

        let res = send_raw(&st, post_launch("/apps/my-app")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let opened = handle.0.lock().expect("handle mutex").clone();
        let [url] = opened.as_slice() else {
            panic!("exactly one URL, got {opened:?}");
        };
        assert!(
            url.starts_with("http://127.0.0.1:8082/launch.html?launch="),
            "the edited launcher drives the launch: {url}",
        );
        assert!(url.ends_with("&iss=http://127.0.0.1:8080/fhir-r4"), "{url}");
    }

    /// Clearing `launchPath` (empty string) reverts a self-hosted app to
    /// root-serving.
    #[tokio::test]
    async fn replace_self_hosted_clear_launch_path_reverts_to_root() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        seed_self_hosted(
            &st.store,
            "My App",
            "my-app",
            Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"),
        );

        let (status, body) = send(
            &st,
            put_json(
                "/self-hosted-apps/my-app",
                serde_json::json!({ "launchPath": "" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert!(
            body.get("launchPath").is_none(),
            "a cleared launch path is absent"
        );

        let res = send_raw(&st, post_launch("/apps/my-app")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            handle.0.lock().expect("handle mutex").clone(),
            vec!["http://127.0.0.1:8082/".to_string()],
            "a cleared launch path serves the bare origin",
        );
    }

    /// A non-origin-relative `launchPath` is rejected `400 InvalidUrl`.
    #[tokio::test]
    async fn replace_self_hosted_rejects_a_non_relative_launch_path() {
        let st = state();
        seed_self_hosted(&st.store, "My App", "my-app", None);
        let (status, body) = send(
            &st,
            put_json(
                "/self-hosted-apps/my-app",
                serde_json::json!({ "launchPath": "https://evil.example/launch" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");
    }

    /// A seeded self-hosted app is launch-path protected — `409 AppNotEditable`.
    #[tokio::test]
    async fn replace_seeded_self_hosted_launch_path_is_409() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/self-hosted-apps/patient-browser",
                serde_json::json!({ "launchPath": "/launch.html" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "AppNotEditable");
    }

    /// A self-hosted path targeting a cloud id is a `404` (wrong kind).
    #[tokio::test]
    async fn replace_self_hosted_of_cloud_id_is_404() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/self-hosted-apps/growth-chart",
                serde_json::json!({ "launchPath": "/launch.html" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A cloud `PUT` fully replaces content: an explicit `subtitle` sets it, and
    /// omitting it (or sending `""`) clears it back to absent.
    #[tokio::test]
    async fn replace_cloud_content_sets_and_clears_subtitle() {
        let st = state();
        let id = {
            let (_, body) = send(
                &st,
                post_json(
                    "/cloud-apps",
                    serde_json::json!({ "name": "Sub", "url": "https://example.com/x", "requiresTunnel": false, "subtitle": "" }),
                ),
            )
            .await;
            assert!(
                body.get("subtitle").is_none(),
                "empty subtitle cleared on create"
            );
            body["id"].as_str().unwrap().to_string()
        };
        let (_, body) = send(
            &st,
            put_json(
                &format!("/cloud-apps/{id}"),
                serde_json::json!({ "name": "Sub", "url": "https://example.com/x", "requiresTunnel": false, "subtitle": "hi" }),
            ),
        )
        .await;
        assert_eq!(body["subtitle"], "hi");
        let (_, body) = send(
            &st,
            put_json(
                &format!("/cloud-apps/{id}"),
                serde_json::json!({ "name": "Sub", "url": "https://example.com/x", "requiresTunnel": false }),
            ),
        )
        .await;
        assert!(
            body.get("subtitle").is_none(),
            "an omitted subtitle clears on a full replace: {body}"
        );
    }

    /// The full seeded set as `{ id, onHomescreen }` entries, in the given id order.
    fn home_screen_body(ordered: &[(&str, bool)]) -> serde_json::Value {
        serde_json::Value::Array(
            ordered
                .iter()
                .map(|(id, enabled)| serde_json::json!({ "id": id, "onHomescreen": enabled }))
                .collect(),
        )
    }

    /// `PUT /home-screen` reorders + disables across every kind in one shot, and
    /// returns the registry in the new order.
    #[tokio::test]
    async fn home_screen_reorders_and_disables_any_kind() {
        let st = state();
        let ordered = [
            ("precise-hbr", true),
            ("medication-viewer", true),
            ("growth-chart", true),
            ("api-docs", false),
            ("api-view", true),
            ("patient-browser", true),
        ];
        let (status, body) = send(&st, put_json("/home-screen", home_screen_body(&ordered))).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let ids: Vec<&str> = body
            .as_array()
            .expect("array")
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![
                "precise-hbr",
                "medication-viewer",
                "growth-chart",
                "api-docs",
                "api-view",
                "patient-browser",
            ],
        );
        let api_docs = body
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "api-docs")
            .unwrap();
        assert_eq!(api_docs["onHomescreen"], false, "api-docs was disabled");

        let (_, list) = send(&st, get("/apps")).await;
        let listed: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(listed, ids, "GET /apps reflects the new order");
    }

    /// A body that isn't an exact permutation (a subset) is `400 InvalidHomeScreen`.
    #[tokio::test]
    async fn home_screen_rejects_a_partial_body() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/home-screen",
                home_screen_body(&[("api-view", true), ("api-docs", true)]),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        assert_eq!(body["error"], "InvalidHomeScreen");
    }

    /// A full-length body that swaps in an unknown id is also `400`.
    #[tokio::test]
    async fn home_screen_rejects_an_unknown_id() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/home-screen",
                home_screen_body(&[
                    ("patient-browser", true),
                    ("api-view", true),
                    ("api-docs", true),
                    ("growth-chart", true),
                    ("medication-viewer", true),
                    ("ghost", true),
                ]),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        assert_eq!(body["error"], "InvalidHomeScreen");
    }

    /// A tiny valid zip (a single `index.html` at the root).
    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write as _;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, contents) in entries {
                if let Some(dir) = name.strip_suffix('/') {
                    writer.add_directory(dir, options).unwrap();
                } else {
                    writer.start_file(*name, options).unwrap();
                    writer.write_all(contents).unwrap();
                }
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    /// A self-hosted upload — `POST /self-hosted-apps` multipart with the `name`
    /// and the zip `bundle` file part.
    fn post_zip(name: &str, bytes: Vec<u8>) -> Request<Body> {
        post_multipart(
            "/self-hosted-apps",
            &[("name", name)],
            Some(("bundle", &bytes)),
        )
    }

    /// The stored `content_folder` for an installed app — the on-disk location
    /// is store-internal (a per-install mint id), so tests resolve it.
    fn content_folder(st: &Arc<AppsState>, id: &str) -> String {
        st.store
            .find_app(id)
            .unwrap()
            .expect("installed app row")
            .1
            .as_self_hosted()
            .expect("self-hosted payload")
            .content_folder
            .clone()
    }

    /// A valid upload installs the app: `200` + `SelfHostedAppDetail`, a DB row,
    /// the files on disk under the row's `content_folder`, and the tile listed last.
    #[tokio::test]
    async fn upload_installs_a_self_hosted_app() {
        let st = state();
        let bytes = zip_bytes(&[("index.html", b"<h1>UP</h1>")]);
        let (status, body) = send(&st, post_zip("My App", bytes)).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["id"], "my-app");
        assert_eq!(body["kind"], "self-hosted");
        assert_eq!(body["isRemovable"], true);
        assert_eq!(body["localOnly"], true);

        let folder = content_folder(&st, "my-app");
        assert_ne!(folder, "my-app", "the folder is the mint id, not the slug");
        let index = st.self_hosted.apps_dir().join(&folder).join("index.html");
        assert_eq!(std::fs::read_to_string(&index).unwrap(), "<h1>UP</h1>");

        let (_s, list) = send(&st, get("/apps")).await;
        let ids: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.last(), Some(&"my-app"), "uploaded app is listed last");
    }

    /// A bundle wrapped in a single top folder serves `index.html` at the root.
    #[tokio::test]
    async fn upload_hoists_a_single_wrapper_folder() {
        let st = state();
        let bytes = zip_bytes(&[("my-app/", b""), ("my-app/index.html", b"<h1>WRAPPED</h1>")]);
        let (status, body) = send(&st, post_zip("My App", bytes)).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let index = st
            .self_hosted
            .apps_dir()
            .join(content_folder(&st, "my-app"))
            .join("index.html");
        assert_eq!(std::fs::read_to_string(&index).unwrap(), "<h1>WRAPPED</h1>");
    }

    /// End-to-end: a bundle shipping `launch.html` is installed as a SMART launcher.
    #[tokio::test]
    async fn upload_with_launch_html_launches_the_smart_launcher() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        let bytes = zip_bytes(&[("launch.html", b"<launcher>"), ("index.html", b"<app>")]);
        let (status, body) = send(&st, post_zip("My App", bytes)).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let res = send_raw(&st, post_launch("/apps/my-app")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let opened = handle.0.lock().expect("handle mutex").clone();
        let [url] = opened.as_slice() else {
            panic!("exactly one URL, got {opened:?}");
        };
        assert!(
            url.starts_with("http://127.0.0.1:8082/launch.html?launch="),
            "launcher hangs off the app's own loopback origin: {url}",
        );
        assert!(
            url.ends_with("&iss=http://127.0.0.1:8080/fhir-r4"),
            "iss resolves to the host API origin, not the app's port: {url}",
        );
        assert!(
            !url.contains("{launch}") && !url.contains("{origin}"),
            "every placeholder is substituted: {url}",
        );
    }

    /// A duplicate name (same slug) is rejected `400 InvalidName`; the first app
    /// stays untouched.
    #[tokio::test]
    async fn upload_rejects_a_duplicate_name() {
        let st = state();
        let (s1, first) = send(&st, post_zip("My App", zip_bytes(&[("index.html", b"a")]))).await;
        assert_eq!(s1, StatusCode::OK);
        assert_eq!(first["id"], "my-app");

        let (s2, body) = send(&st, post_zip("My App", zip_bytes(&[("index.html", b"b")]))).await;
        assert_eq!(s2, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidName");
        // The original app is still the only `my-app`, its files intact.
        let (_s, list) = send(&st, get("/apps")).await;
        let my_apps = list
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["id"] == "my-app")
            .count();
        assert_eq!(my_apps, 1, "the duplicate upload created no second row");
    }

    /// Garbage bytes are rejected `400 InvalidZip`, with no row created.
    #[tokio::test]
    async fn upload_rejects_garbage_bytes() {
        let st = state();
        let (status, body) = send(&st, post_zip("My App", b"not a zip".to_vec())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidZip");
        assert!(st.store.find_app("my-app").unwrap().is_none());
    }

    /// A name that slugs to nothing is rejected `400 InvalidName`.
    #[tokio::test]
    async fn upload_rejects_a_nameless_slug() {
        let st = state();
        let (status, body) = send(&st, post_zip("!!!", zip_bytes(&[("index.html", b"x")]))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidName");
    }

    /// An uploaded app is deletable (`204`, rows + files gone); the seeded
    /// patient-browser stays protected (`409`).
    #[tokio::test]
    async fn uploaded_app_is_deletable_but_seeded_is_protected() {
        let st = state();
        let (_s, created) = send(&st, post_zip("My App", zip_bytes(&[("index.html", b"x")]))).await;
        let id = created["id"].as_str().unwrap().to_owned();
        let dir = st.self_hosted.apps_dir().join(content_folder(&st, &id));
        assert!(dir.exists(), "files present after install");

        let res = send_raw(&st, delete(&format!("/apps/{id}"))).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(st.store.find_app(&id).unwrap().is_none(), "row removed");
        assert!(!dir.exists(), "files removed");

        let (_s, list) = send(&st, get("/apps")).await;
        assert!(
            list.as_array()
                .unwrap()
                .iter()
                .all(|v| v["id"] != id.as_str()),
            "deleted app no longer listed",
        );

        let (status, body) = send(&st, delete("/apps/patient-browser")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "AppNotEditable");
    }

    // --- Scope gating (the `Scoped<…>` admin capabilities) --------------------

    /// A gated read reached with **no** scope claim is `403 InsufficientScope`
    /// naming the exact scope the caller lacks — never the `200` body.
    #[tokio::test]
    async fn gated_read_without_any_scope_is_403_insufficient_scope() {
        let st = state();
        let (status, body) = send_scoped(&st, get("/apps"), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "InsufficientScope");
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["wildflower/Apps.r"])
        );
    }

    /// The exact resource scope (not just the `wildflower/*` wildcard) satisfies a
    /// gated read — so the gate keys on coverage, not on holding the owner wildcard.
    #[tokio::test]
    async fn gated_read_with_exact_apps_read_scope_is_allowed() {
        let st = state();
        let (status, _body) = send_scoped(&st, get("/apps"), Some("wildflower/Apps.r")).await;
        assert_eq!(status, StatusCode::OK);

        // A cross-resource scope does NOT cover it — `wildflower/*` never reaches
        // across to the launch known scope, and a sibling resource read doesn't
        // grant Apps.
        let (status, body) = send_scoped(&st, get("/apps"), Some("wildflower/Grant.cruds")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["wildflower/Apps.r"])
        );
    }

    /// Each write capability gates on its own permission: a token holding only
    /// `Apps.r` is `403` on create (`Apps.c`), edit (`Apps.u`), and delete
    /// (`Apps.d`), each naming the missing scope — a read grant can't write.
    #[tokio::test]
    async fn write_capabilities_reject_a_read_only_token() {
        let read_only = Some("wildflower/Apps.r");

        let st = state();
        let (status, body) = send_scoped(
            &st,
            post_create_cloud("My App", "https://example.com/launch", false),
            read_only,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "create needs Apps.c");
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["wildflower/Apps.c"])
        );

        let (status, body) = send_scoped(
            &st,
            put_json("/home-screen", serde_json::json!([])),
            read_only,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "home-screen edit needs Apps.u"
        );
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["wildflower/Apps.u"])
        );

        let (status, body) = send_scoped(&st, delete("/apps/growth-chart"), read_only).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "delete needs Apps.d");
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["wildflower/Apps.d"])
        );
    }

    /// The scope gate runs **before** the handler body: an under-scoped delete of a
    /// protected app is `403` (the scope check), not the `409` it would be with the
    /// scope — a forgotten permission can't leak the removability verdict.
    #[tokio::test]
    async fn scope_gate_precedes_the_handler_verdict() {
        let st = state();
        let (status, body) =
            send_scoped(&st, delete("/apps/api-docs"), Some("wildflower/Apps.r")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "InsufficientScope");
    }
}
