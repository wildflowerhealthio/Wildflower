//! HTTP routes for the apps slice, grouped into a [`gated_openapi_router`]
//! (the catalogue reads and writes, and home-screen) and a
//! [`launch_openapi_router`] (`POST /apps/{id}`), merged into [`openapi_router`]
//! for the spec + route tests. The served routes and the OpenAPI spec come from the
//! same `#[utoipa::path]`-annotated handlers. One file per route named by
//! operation, under a folder tree mirroring the URL tree: [`apps`] holds `/apps`
//! (list, create, read, replace, delete, launch) and [`home_screen`] the flat
//! `/home-screen` route. The gating split is documented on the [`crate::http`]
//! router builders these back.

mod apps;
mod home_screen;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::live_bindings::state::AppsState;

/// The scope-gated admin routes as an `OpenApiRouter`, each gated on
/// `wildflower/Apps.{r,c,u,d}` (the spec-bearing inner of
/// [`gated_router`](super::gated_router), which documents the gating split):
///
///  - `GET`/`POST /apps` (registry list, create) and `GET`/`PUT`/`DELETE
///    /apps/{id}` (read, content replace, delete) — see [`apps`];
///  - `PUT /home-screen` (atomic reorder / enable) — see [`home_screen`].
pub(crate) fn gated_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new()
        .routes(routes!(
            apps::list_all::handle_list_apps,
            apps::create::handle_create_app
        ))
        .routes(routes!(
            apps::get_by_id::handle_get_app,
            apps::update_by_id::handle_update_app,
            apps::delete_by_id::handle_delete_app
        ))
        .routes(routes!(home_screen::handle_replace_home_screen))
}

/// The launch route (`POST /apps/{id}`) as an `OpenApiRouter` — the spec-bearing
/// inner of [`launch_router`](super::launch_router), which documents why it's kept
/// ungated and separate from [`gated_openapi_router`].
pub(crate) fn launch_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new().routes(routes!(apps::launch::handle_launch_app))
}

/// The full apps surface (gated routes + launch) as one `OpenApiRouter`. Backs
/// [`openapi_spec`](super::openapi_spec) — the committed snapshot. The host mounts the two halves separately (via
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

    // The port trait is in scope so the concrete store's `insert_app` /
    // `find_app` methods resolve in the fixtures.
    use crate::domain::{AppRegistration, AppsStore};
    use crate::http::test_support::{
        state, state_with_launch_scopes, state_with_sink, state_with_tunnel_and_handle, tunnel_at,
        tunnel_unavailable, FixedLaunchScopes,
    };
    use crate::live_bindings::state::AppsState;
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

    /// The launch URL a forwarded launch's `200` body names.
    async fn launch_url(res: axum::response::Response) -> String {
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).expect("json body");
        body["url"].as_str().expect("a url field").to_owned()
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

    /// A create — `POST /apps` JSON.
    fn post_create(name: &str, url: &str, requires_tunnel: bool) -> Request<Body> {
        post_json(
            "/apps",
            serde_json::json!({ "name": name, "url": url, "requiresTunnel": requires_tunnel }),
        )
    }

    /// The seeded registry, in display order.
    const SEEDED_IDS: [&str; 9] = [
        "growth-chart",
        "medication-viewer",
        "precise-hbr",
        "medications-app",
        "web-trace-app",
        "web-server-docs",
        "importer-app",
        "ohif-viewer",
        "lifting-app",
    ];

    /// Seed an app directly through the store (the fixture shortcut a test uses
    /// instead of driving `POST /apps`).
    fn seed_app(store: &crate::db::SqliteAppsStore, id: &str, url: &str, client_id: Option<&str>) {
        let registration = AppRegistration {
            id: id.to_owned(),
            position: 0,
            on_homescreen: true,
            name: id.to_owned(),
            subtitle: None,
            url: url.parse().expect("a valid test launch url"),
            client_id: client_id.map(str::to_owned),
            requires_tunnel: false,
        };
        store.insert_app(&registration).unwrap().expect("inserted");
    }

    /// Seed a non-SMART app whose template names the served origin — the
    /// fixture the provenance and umbrella tests drive.
    fn seed_plain(store: &crate::db::SqliteAppsStore, id: &str) {
        seed_app(store, id, "https://app.example/y?iss={origin}", None);
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
        assert_eq!(ids, SEEDED_IDS);
    }

    /// Every list item is the app's registration: the catalogue facts and the
    /// stored launch template; `position` and `clientId` stay on the host.
    #[tokio::test]
    async fn list_apps_items_carry_the_registration_and_its_url() {
        let st = state();
        let (_status, body) = send(&st, get("/apps")).await;
        let arr = body.as_array().unwrap();
        let growth = arr.iter().find(|v| v["id"] == "growth-chart").unwrap();
        assert_eq!(growth["isSmart"], true);
        assert_eq!(growth["requiresTunnel"], true);
        assert!(growth["url"].as_str().unwrap().contains("{origin}"));
        for absent in ["position", "clientId"] {
            assert!(growth.get(absent).is_none(), "{absent} is not on the wire");
        }
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
        seed_plain(&st.store, "app-y");
        let res =
            send_raw_scoped(&st, post_launch("/apps/app-y"), Some("wildflower/*.cruds")).await;
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
    /// router with the same bearer gate): with the scope it answers the launch URL,
    /// without it 403s — the front doesn't bypass authorization.
    #[tokio::test]
    async fn forwarded_launch_requires_the_umbrella_scope() {
        let st = state();
        seed_plain(&st.store, "app-y");
        let ok = send_raw(&st, post_forwarded("/apps/app-y")).await;
        assert_eq!(ok.status(), StatusCode::OK);

        let denied = send_raw_scoped(
            &st,
            post_forwarded("/apps/app-y"),
            Some("wildflower/*.cruds"),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    /// Seed a **SMART** app (a `client_id` present) — the fixture the per-app
    /// SMART launch tests drive.
    fn seed_smart(store: &crate::db::SqliteAppsStore, id: &str) {
        seed_app(store, id, "https://app.example/smart", Some("client-1"));
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
        seed_smart(&st.store, "smart-app");
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
        seed_smart(&st.store, "smart-app");
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

    /// A non-SMART app ignores the launch-scopes port entirely: even with a port
    /// requiring a scope the caller lacks, it launches (the SMART check
    /// short-circuits on `is_smart() == false`).
    #[tokio::test]
    async fn launch_non_smart_app_ignores_the_launch_scopes_port() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_launch_scopes(
            Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>,
            FixedLaunchScopes::requiring("patient/Observation.r"),
        );
        seed_plain(&st.store, "app-y");
        let res = send_raw_scoped(&st, post_launch("/apps/app-y"), Some("wildflower/launch")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    /// No launch sets a cookie — forwarded or loopback.
    #[tokio::test]
    async fn no_launch_sets_a_cookie() {
        let st = state();
        seed_plain(&st.store, "app-y");
        for (request, status) in [
            (post_forwarded("/apps/app-y"), StatusCode::OK),
            (post_launch("/apps/app-y"), StatusCode::NO_CONTENT),
        ] {
            let res = send_raw(&st, request).await;
            assert_eq!(res.status(), status);
            assert!(res.headers().get("set-cookie").is_none());
        }
    }

    /// A `requires_tunnel` launch with the tunnel down is 503; no popup.
    #[tokio::test]
    async fn launch_requires_tunnel_with_tunnel_down_is_503() {
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

    /// A `requires_tunnel` launch resolves to the verified tunnel origin.
    #[tokio::test]
    async fn launch_resolves_to_the_verified_tunnel_origin() {
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

    /// A non-tunnel loopback launch substitutes the loopback origin.
    #[tokio::test]
    async fn launch_substitutes_the_loopback_origin() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        seed_plain(&st.store, "app-y");
        let res = send_raw(&st, post_launch("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            handle.0.lock().expect("handle mutex").clone(),
            vec!["https://app.example/y?iss=http://127.0.0.1:8080".to_string()],
        );
    }

    /// A forwarded launch resolves `{origin}` against the served origin and
    /// answers the URL rather than opening a host popup.
    #[tokio::test]
    async fn launch_forwarded_answers_the_served_origin_url() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        seed_plain(&st.store, "app-y");
        let res = send_raw(&st, post_forwarded("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            launch_url(res).await,
            "https://app.example/y?iss=https://demo.example.com"
        );
        assert!(handle.0.lock().expect("handle mutex").is_empty());
    }

    /// A row whose stored url no longer parses fails the typed read → 500.
    #[tokio::test]
    async fn launch_rejects_unparseable_stored_url_as_500() {
        use diesel::prelude::*;

        let st = state();
        let mut conn = st.store.pool().get().unwrap();
        // growth-chart requires the tunnel; drop requires_tunnel too so the launch
        // reaches the url read rather than 503-ing on the down tunnel.
        diesel::sql_query(
            "UPDATE app_registrations SET url = 'javascript:alert(1)', requires_tunnel = 0 \
             WHERE id = 'growth-chart'",
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
            post_create("My App", "https://example.com/launch", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert!(body["onHomescreen"].as_bool().unwrap());
        assert_eq!(body["url"], "https://example.com/launch");
        let id = body["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let (status, body) = send(
            &st,
            put_json(
                &format!("/apps/{id}"),
                serde_json::json!({
                    "name": "Renamed",
                    "url": "https://example.com/other",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");
        assert_eq!(body["url"], "https://example.com/other");

        let (status, body) = send(&st, get(&format!("/apps/{id}"))).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");

        let res = send_raw(&st, delete(&format!("/apps/{id}"))).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(st.store.find_app(&id).unwrap().is_none());
    }

    #[tokio::test]
    async fn create_rejects_bad_url_and_empty_name() {
        let st = state();
        let (status, body) = send(&st, post_create("Bad", "javascript:alert(1)", false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");

        let (status, body) = send(&st, post_create("", "https://example.com/x", false)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidName");
    }

    /// The by-id read, replace, and delete all 404 on an unknown id; a replace
    /// resolves the app before validating any field, so a bad url on an unknown id
    /// is still a 404.
    #[tokio::test]
    async fn by_id_paths_reject_an_unknown_id() {
        let st = state();

        let (status, body) = send(&st, get("/apps/no-such-id")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");

        let (status, body) = send(
            &st,
            put_json(
                "/apps/no-such-id",
                serde_json::json!({ "name": "x", "url": "javascript:alert(1)", "requiresTunnel": false }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");

        let (status, body) = send(&st, delete("/apps/no-such-id")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A seeded app's content is replaceable through `/apps/{id}`, and the
    /// response carries the new `url`; it's deletable too.
    #[tokio::test]
    async fn seeded_app_can_be_edited_and_deleted() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/apps/growth-chart",
                serde_json::json!({ "name": "Renamed", "url": "https://example.com/x", "requiresTunnel": true }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");
        assert_eq!(body["url"], "https://example.com/x");
        assert_eq!(body["requiresTunnel"], true);
        assert_eq!(body["isSmart"], true, "a replace keeps the client_id");

        let res = send_raw(&st, delete("/apps/growth-chart")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let (status, _) = send(&st, get("/apps/growth-chart")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// A `PUT` fully replaces content: an explicit `subtitle` sets it, and
    /// omitting it (or sending `""`) clears it back to absent.
    #[tokio::test]
    async fn replace_content_sets_and_clears_subtitle() {
        let st = state();
        let id = {
            let (_, body) = send(
                &st,
                post_json(
                    "/apps",
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
                &format!("/apps/{id}"),
                serde_json::json!({ "name": "Sub", "url": "https://example.com/x", "requiresTunnel": false, "subtitle": "hi" }),
            ),
        )
        .await;
        assert_eq!(body["subtitle"], "hi");
        let (_, body) = send(
            &st,
            put_json(
                &format!("/apps/{id}"),
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

    /// `PUT /home-screen` reorders + disables in one shot, and returns the
    /// registry in the new order.
    #[tokio::test]
    async fn home_screen_reorders_and_disables() {
        let st = state();
        let ordered = [
            ("precise-hbr", true),
            ("medication-viewer", true),
            ("growth-chart", false),
            ("medications-app", true),
            ("web-trace-app", true),
            ("web-server-docs", true),
            ("importer-app", true),
            ("ohif-viewer", true),
            ("lifting-app", true),
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
                "medications-app",
                "web-trace-app",
                "web-server-docs",
                "importer-app",
                "ohif-viewer",
                "lifting-app",
            ],
        );
        let growth = body
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "growth-chart")
            .unwrap();
        assert_eq!(growth["onHomescreen"], false, "growth-chart was disabled");

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
                home_screen_body(&[("growth-chart", true), ("precise-hbr", true)]),
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
                    ("growth-chart", true),
                    ("medication-viewer", true),
                    ("precise-hbr", true),
                    ("medications-app", true),
                    ("web-trace-app", true),
                    ("web-server-docs", true),
                    ("importer-app", true),
                    ("ohif-viewer", true),
                    ("ghost", true),
                ]),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        assert_eq!(body["error"], "InvalidHomeScreen");
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
            post_create("My App", "https://example.com/launch", false),
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

    /// The scope gate runs **before** the handler body: an under-scoped delete of
    /// an unknown id is `403` (the scope check), not the `404` it would be with the
    /// scope — a forgotten permission can't leak existence.
    #[tokio::test]
    async fn scope_gate_precedes_the_handler_verdict() {
        let st = state();
        let (status, body) =
            send_scoped(&st, delete("/apps/no-such-id"), Some("wildflower/Apps.r")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "InsufficientScope");
    }
}
