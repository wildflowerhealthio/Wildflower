//! HTTP handlers for the apps slice, grouped into a [`gated_openapi_router`]
//! (list, cloud-admin, home-screen) and a [`launch_openapi_router`]
//! (`POST /apps/{id}`), merged into [`openapi_router`] for the spec + handler
//! tests. The served routes and the OpenAPI spec come from the same
//! `#[utoipa::path]`-annotated handlers. The gating split is documented on the
//! [`crate::http`] router builders these back.

mod apps;
mod cloud_admin;
mod home_screen;
#[cfg(test)]
pub(crate) mod test_utils;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AppsState;

/// The owner-gated routes as an `OpenApiRouter` (the spec-bearing inner of
/// [`gated_router`](super::gated_router), which documents the gating split):
///
///  - `GET /apps` (list) — see [`apps`];
///  - `POST /apps` (create) + `PATCH`/`DELETE /apps/{id}` (cloud admin) — see
///    [`cloud_admin`];
///  - `PUT /home-screen` (atomic reorder / enable, any provenance) — see
///    [`home_screen`].
pub(crate) fn gated_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new()
        .routes(routes!(apps::list::handle_list_apps))
        .routes(routes!(cloud_admin::create::handle_create_app))
        .routes(routes!(
            cloud_admin::update::handle_update_app,
            cloud_admin::delete::handle_delete_app
        ))
        .routes(routes!(home_screen::handle_replace_home_screen))
}

/// The launch route (`POST /apps/{id}`) as an `OpenApiRouter` — the spec-bearing
/// inner of [`launch_router`](super::launch_router), which documents why it's
/// kept ungated and separate from [`gated_openapi_router`].
pub(crate) fn launch_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new().routes(routes!(apps::launch::handle_launch_app))
}

/// The full apps surface (gated routes + launch) as one `OpenApiRouter`. Used for
/// the OpenAPI snapshot and the handler tests; the host mounts the two halves
/// separately (via [`gated_openapi_router`] / [`launch_openapi_router`]) so it can
/// gate them differently — hence this combined form is test-only.
#[cfg(test)]
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

    use super::test_utils::{
        state, state_owner_denied, state_owner_denied_with_sink, state_with_sink,
        state_with_tunnel, state_with_tunnel_and_handle, tunnel_at, tunnel_unavailable,
        tunnel_with_public_host,
    };
    use crate::domain::{AppEntry, AppUrl};
    use crate::http::state::AppsState;

    /// The served router (state applied per-call). Spec half of
    /// `split_for_parts` is irrelevant in the handler tests.
    fn router() -> Router<Arc<AppsState>> {
        super::openapi_router().split_for_parts().0
    }

    async fn send(state: &Arc<AppsState>, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let res = router()
            .with_state(Arc::clone(state))
            .oneshot(req)
            .await
            .expect("oneshot");
        let status = res.status();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    async fn send_raw(state: &Arc<AppsState>, req: Request<Body>) -> axum::response::Response {
        router()
            .with_state(Arc::clone(state))
            .oneshot(req)
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

    fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn patch(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PATCH")
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

    fn cloud(id: &str, url: AppUrl) -> AppEntry {
        AppEntry {
            id: id.to_owned(),
            enabled: true,
            name: id.to_owned(),
            subtitle: None,
            url,
            requires_tunnel: false,
        }
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

    /// The list carries the registry flags and omits `url`.
    #[tokio::test]
    async fn list_apps_carries_flags_and_omits_url() {
        let st = state();
        let (_status, body) = send(&st, get("/apps")).await;
        let arr = body.as_array().unwrap();
        let growth = arr.iter().find(|v| v["id"] == "growth-chart").unwrap();
        assert_eq!(growth["provenance"], "cloud");
        assert_eq!(growth["smart"], true);
        assert_eq!(growth["requiresTunnel"], true);
        assert_eq!(growth["localOnly"], false);
        assert!(growth.get("url").is_none(), "GET /apps must not expose url");

        let api_view = arr.iter().find(|v| v["id"] == "api-view").unwrap();
        assert_eq!(api_view["provenance"], "system");
        assert_eq!(api_view["localOnly"], true);
        assert_eq!(api_view["smart"], false);
    }

    #[tokio::test]
    async fn launch_unknown_id_is_404() {
        let st = state();
        let (status, body) = send(&st, post_launch("/apps/no-such-thing")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A loopback launch whose owner gate denies → 401, no popup.
    #[tokio::test]
    async fn loopback_launch_denied_by_owner_gate_is_401() {
        let st = state_owner_denied();
        let res = send_raw(&st, post_launch("/apps/api-docs")).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    /// The loopback owner gate runs *before* any lookup or side-effect: a denied
    /// caller 401s without triggering the tunnel or revealing existence.
    ///
    /// `growth-chart` is `requires_tunnel`, so resolving it with the tunnel down
    /// would `503` — that the denied launch is `401` proves resolution (and its
    /// `tunnel.try_start`) never ran; the popup handle stays empty. An unknown id
    /// likewise `401`s rather than `404`, so existence isn't an oracle either.
    #[tokio::test]
    async fn loopback_owner_gate_precedes_resolution_and_side_effects() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st =
            state_owner_denied_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);

        let res = send_raw(&st, post_launch("/apps/growth-chart")).await;
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "denied loopback launch must 401 before the requires_tunnel 503",
        );
        assert!(
            handle.0.lock().expect("handle mutex").is_empty(),
            "a denied caller opens no popup",
        );

        let res = send_raw(&st, post_launch("/apps/no-such-thing")).await;
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "denied loopback launch of an unknown id must 401, not 404",
        );
    }

    /// A forwarded launch skips the owner gate (front is the trust boundary).
    #[tokio::test]
    async fn forwarded_launch_skips_owner_gate() {
        // Owner-denied state, but a forwarded request must still 302.
        let st = state_owner_denied();
        let res = send_raw(&st, post_forwarded("/apps/api-docs")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
    }

    /// A system app launches via its compiled-in source URL, resolved against
    /// the loopback origin for a local caller.
    #[tokio::test]
    async fn launch_system_app_resolves_compiled_in_url() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        let res = send_raw(&st, post_launch("/apps/api-docs")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let opened = handle.0.lock().expect("handle mutex").clone();
        assert_eq!(opened, vec!["http://127.0.0.1:8080/docs".to_string()]);
    }

    /// A seeded `system` row with no compiled-in source resolves to a logged 500
    /// (never a panic).
    #[tokio::test]
    async fn launch_system_app_without_source_is_500() {
        let st = state();
        // Insert a system parent row whose id has no SYSTEM_APPS entry.
        st.store
            .conn()
            .lock()
            .execute(
                "INSERT INTO apps (id, name, enabled, position, provenance, local_only) \
                 VALUES ('ghost-system', 'Ghost', 1, 99, 'system', 1)",
                [],
            )
            .unwrap();
        let res = send_raw(&st, post_launch("/apps/ghost-system")).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A forwarded launch of a self-hosted app with `public_host` redirects to
    /// the public subdomain.
    #[tokio::test]
    async fn launch_self_hosted_forwarded_redirects_to_subdomain() {
        let st = state_with_tunnel(tunnel_with_public_host("demo.example.com"));
        let res = send_raw(&st, post_forwarded("/apps/patient-browser")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res.headers().get("location").unwrap().to_str().unwrap();
        assert_eq!(location, "https://patient-browser.demo.example.com/");
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
        st.store
            .insert_cloud_app(&cloud("app-y", AppUrl::OriginRelative("/y".to_owned())))
            .unwrap();
        let res = send_raw(&st, post_launch("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            handle.0.lock().expect("handle mutex").clone(),
            vec!["http://127.0.0.1:8080/y".to_string()],
        );
    }

    /// A forwarded cloud launch resolves `{origin}` against the served (public)
    /// origin, not loopback, and 302s without invoking the handle.
    #[tokio::test]
    async fn launch_cloud_forwarded_uses_served_origin_and_302s() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        st.store
            .insert_cloud_app(&cloud("app-y", AppUrl::OriginRelative("/y".to_owned())))
            .unwrap();
        let res = send_raw(&st, post_forwarded("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res.headers().get("location").unwrap().to_str().unwrap();
        assert_eq!(location, "https://demo.example.com/y");
        assert!(handle.0.lock().expect("handle mutex").is_empty());
    }

    /// A cloud row whose stored url no longer parses fails the typed read → 500.
    #[tokio::test]
    async fn launch_rejects_unparseable_stored_cloud_url_as_500() {
        let st = state();
        st.store
            .conn()
            .lock()
            .execute(
                "UPDATE cloud_apps SET url = 'http://evil.example.com' WHERE id = 'growth-chart'",
                [],
            )
            .unwrap();
        // growth-chart requires the tunnel; use a non-tunnel cloud app instead by
        // dropping requires_tunnel so the launch reaches the url read.
        st.store
            .conn()
            .lock()
            .execute(
                "UPDATE cloud_apps SET requires_tunnel = 0 WHERE id = 'growth-chart'",
                [],
            )
            .unwrap();
        let res = send_raw(&st, post_launch("/apps/growth-chart")).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn full_round_trip_create_update_delete() {
        let st = state();
        let (status, body) = send(
            &st,
            post_json(
                "/apps",
                serde_json::json!({
                    "name": "My App",
                    "url": "https://example.com/launch",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert!(body["enabled"].as_bool().unwrap());
        let id = body["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let (status, body) = send(
            &st,
            patch(
                &format!("/apps/{id}"),
                serde_json::json!({ "name": "Renamed" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");

        let (status, body) = send(&st, delete(&format!("/apps/{id}"))).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["deleted"], true);
    }

    #[tokio::test]
    async fn create_rejects_bad_url_and_empty_name() {
        let st = state();
        let (status, body) = send(
            &st,
            post_json(
                "/apps",
                serde_json::json!({ "name": "Bad", "url": "javascript:alert(1)", "requiresTunnel": false }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");

        let (status, body) = send(
            &st,
            post_json(
                "/apps",
                serde_json::json!({ "name": "", "url": "https://example.com/x", "requiresTunnel": false }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidName");
    }

    /// Update + delete reject system and self-hosted apps with `AppNotEditable`
    /// (409), an unknown id with `AppNotFound` (404).
    #[tokio::test]
    async fn admin_rejects_non_cloud_and_unknown() {
        let st = state();
        for id in ["api-docs", "patient-browser"] {
            let (status, body) = send(
                &st,
                patch(&format!("/apps/{id}"), serde_json::json!({ "name": "x" })),
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "{id} update");
            assert_eq!(body["error"], "AppNotEditable");

            let (status, body) = send(&st, delete(&format!("/apps/{id}"))).await;
            assert_eq!(status, StatusCode::CONFLICT, "{id} delete");
            assert_eq!(body["error"], "AppNotEditable");
        }

        let (status, body) = send(
            &st,
            patch("/apps/no-such-id", serde_json::json!({ "name": "x" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");

        let (status, body) = send(&st, delete("/apps/no-such-id")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A seeded cloud app's content (name / url) is editable through the
    /// cloud-admin surface. (`enabled` is not a content field — see
    /// `PUT /home-screen`.)
    #[tokio::test]
    async fn seeded_cloud_app_can_be_edited_and_deleted() {
        let st = state();
        let (status, body) = send(
            &st,
            patch(
                "/apps/growth-chart",
                serde_json::json!({ "name": "Renamed", "url": "https://example.com/x" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");
        assert_eq!(body["url"], "https://example.com/x");

        let (status, _) = send(&st, delete("/apps/growth-chart")).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// Existence/editability resolves before field validation: a PATCH to a
    /// non-cloud id with an also-bad url is 409, not 400.
    #[tokio::test]
    async fn non_cloud_update_with_bad_url_is_409() {
        let st = state();
        let (status, body) = send(
            &st,
            patch(
                "/apps/api-docs",
                serde_json::json!({ "url": "javascript:alert(1)" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "AppNotEditable");
    }

    /// The tri-state subtitle patch still distinguishes absent from null/empty.
    #[tokio::test]
    async fn update_subtitle_tri_state() {
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
        // Set, then keep on an unrelated patch, then clear via null.
        send(
            &st,
            patch(
                &format!("/apps/{id}"),
                serde_json::json!({ "subtitle": "hi" }),
            ),
        )
        .await;
        let (_, body) = send(
            &st,
            patch(
                &format!("/apps/{id}"),
                serde_json::json!({ "requiresTunnel": true }),
            ),
        )
        .await;
        assert_eq!(body["subtitle"], "hi");
        let (_, body) = send(
            &st,
            patch(
                &format!("/apps/{id}"),
                serde_json::json!({ "subtitle": null }),
            ),
        )
        .await;
        assert!(body.get("subtitle").is_none() || body["subtitle"].is_null());
    }

    /// The full seeded set as `{ id, enabled }` entries, in the given id order.
    fn home_screen_body(ordered: &[(&str, bool)]) -> serde_json::Value {
        serde_json::Value::Array(
            ordered
                .iter()
                .map(|(id, enabled)| serde_json::json!({ "id": id, "enabled": enabled }))
                .collect(),
        )
    }

    /// `PUT /home-screen` reorders + disables across every provenance in one
    /// shot, and returns the catalogue in the new order. Reverses the seed and
    /// disables a system app (api-docs).
    #[tokio::test]
    async fn home_screen_reorders_and_disables_any_provenance() {
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

        // The response is the catalogue in its new order.
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
        assert_eq!(api_docs["enabled"], false, "api-docs was disabled");

        // A follow-up GET sees the same order persisted.
        let (_, list) = send(&st, get("/apps")).await;
        let listed: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(listed, ids, "GET /apps reflects the new order");
    }

    /// A body that isn't an exact permutation of the registry (here a subset) is
    /// rejected `400 InvalidHomeScreen` — nothing is reordered.
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

    /// A full-length body that swaps in an unknown id (so it's not a permutation)
    /// is also `400` — guarding the "every app exactly once" invariant.
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
}
