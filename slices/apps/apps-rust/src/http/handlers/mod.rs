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

use axum::extract::DefaultBodyLimit;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AppsState;

/// The raw request-body cap for `POST /apps` (which accepts a self-hosted
/// upload). Scoped to just that route (the rest of the surface keeps axum's
/// small default), sized to the largest bundle we accept — the 512 MiB
/// *extracted* cap still applies inside the handler.
const UPLOAD_BODY_LIMIT_BYTES: usize = 64 * 1024 * 1024;

/// The owner-gated routes as an `OpenApiRouter` (the spec-bearing inner of
/// [`gated_router`](super::gated_router), which documents the gating split):
///
///  - `GET /apps` (list) — see [`apps`];
///  - `POST /apps` (create a cloud or self-hosted app) + `PUT`/`DELETE /apps/{id}`
///    (content replace + delete) — see [`cloud_admin`];
///  - `PUT /home-screen` (atomic reorder / enable, any provenance) — see
///    [`home_screen`].
pub(crate) fn gated_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    // `POST /apps` accepts a self-hosted upload, so its body limit is raised well
    // above axum's small default; building it as its own router and layering the
    // limit there scopes the raise to this one route (a `.layer` on the whole
    // router would loosen every endpoint).
    let create_router = OpenApiRouter::new()
        .routes(routes!(cloud_admin::create::handle_create_app))
        .layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT_BYTES));

    OpenApiRouter::new()
        .routes(routes!(apps::list::handle_list_apps))
        .routes(routes!(
            cloud_admin::update::handle_replace_app,
            cloud_admin::delete::handle_delete_app
        ))
        .routes(routes!(home_screen::handle_replace_home_screen))
        .merge(create_router)
}

/// The launch route (`POST /apps/{id}`) as an `OpenApiRouter` — the spec-bearing
/// inner of [`launch_router`](super::launch_router), which documents why it's
/// kept ungated and separate from [`gated_openapi_router`].
pub(crate) fn launch_openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new().routes(routes!(apps::launch::handle_launch_app))
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

    use super::test_utils::{
        state, state_owner_denied, state_owner_denied_with_sink, state_with_launch_cookies,
        state_with_sink, state_with_tunnel, state_with_tunnel_and_handle, tunnel_at,
        tunnel_unavailable, tunnel_with_public_host, RecordingLaunchCookies, SENTINEL_SET_COOKIE,
    };
    use crate::db::{CloudContent, NewCloudApp, NewSelfHostedUpload};
    use crate::domain::AppUrl;
    use crate::http::state::AppsState;
    use crate::http::LaunchCookies;

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

    /// Build a `multipart/form-data` POST with text fields and an optional file
    /// part — the shape `POST /apps` now takes for both create kinds.
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

    /// A cloud create — `POST /apps` multipart with `provenance=cloud`.
    fn post_create_cloud(name: &str, url: &str, requires_tunnel: bool) -> Request<Body> {
        post_multipart(
            "/apps",
            &[
                ("provenance", "cloud"),
                ("name", name),
                ("url", url),
                (
                    "requiresTunnel",
                    if requires_tunnel { "true" } else { "false" },
                ),
            ],
            None,
        )
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

    fn cloud(id: &str, url: AppUrl) -> NewCloudApp {
        NewCloudApp {
            id: id.to_owned(),
            content: CloudContent {
                name: id.to_owned(),
                subtitle: None,
                url,
                requires_tunnel: false,
            },
        }
    }

    fn upload(name: &str, base_slug: &str, launch_path: Option<&str>) -> NewSelfHostedUpload {
        NewSelfHostedUpload {
            name: name.to_owned(),
            subtitle: None,
            base_slug: base_slug.to_owned(),
            content_folder: format!("{base_slug}-folder"),
            reserved_ports: Vec::new(),
            launch_path: launch_path.map(str::to_owned),
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

    /// The list is a `provenance`-discriminated union: the cloud variant carries
    /// its stored `url` **template** (with `{origin}` tokens) and `requiresTunnel`;
    /// the system variant carries neither (no child table).
    #[tokio::test]
    async fn list_apps_is_a_provenance_union_with_cloud_url_template() {
        let st = state();
        let (_status, body) = send(&st, get("/apps")).await;
        let arr = body.as_array().unwrap();
        let growth = arr.iter().find(|v| v["id"] == "growth-chart").unwrap();
        assert_eq!(growth["provenance"], "cloud");
        assert_eq!(growth["smart"], true);
        assert_eq!(growth["requiresTunnel"], true);
        assert_eq!(growth["localOnly"], false);
        assert!(
            growth["url"]
                .as_str()
                .is_some_and(|u| u.contains("{origin}")),
            "the cloud variant carries the stored url template: {growth}",
        );

        let api_view = arr.iter().find(|v| v["id"] == "api-view").unwrap();
        assert_eq!(api_view["provenance"], "system");
        assert_eq!(api_view["localOnly"], true);
        assert_eq!(api_view["smart"], false);
        assert!(
            api_view.get("url").is_none(),
            "the system variant has no url",
        );
        assert!(
            api_view.get("requiresTunnel").is_none(),
            "the system variant has no requiresTunnel",
        );
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

    /// A forwarded self-hosted launch plants the re-scoped owner session on the
    /// `302`, asking the seam to scope it onto the same `public_host` that built
    /// the subdomain URL.
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

    /// A forwarded *cloud* launch plants no session cookie — the seam is only for
    /// self-hosted apps served on their own subdomain (a cloud app authenticates
    /// through its own OAuth flow), so the recorder is never asked.
    #[tokio::test]
    async fn launch_cloud_forwarded_plants_no_session_cookie() {
        let recorder = Arc::new(RecordingLaunchCookies::default());
        let st = state_with_launch_cookies(
            tunnel_with_public_host("demo.example.com"),
            Arc::clone(&recorder) as Arc<dyn LaunchCookies>,
        );
        st.store
            .insert_cloud_app(&cloud("app-y", AppUrl::OriginRelative("/y".to_owned())))
            .unwrap();
        let res = send_raw(&st, post_forwarded("/apps/app-y")).await;
        assert_eq!(res.status(), StatusCode::FOUND);
        assert!(res.headers().get("set-cookie").is_none());
        assert!(recorder.hosts.lock().unwrap().is_empty());
    }

    /// A *loopback* self-hosted launch plants no session cookie: it `204`s to the
    /// `127.0.0.1` origin (already reached by the host cookie / connection
    /// provenance), so the seam is never asked.
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
            post_create_cloud("My App", "https://example.com/launch", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert!(body["enabled"].as_bool().unwrap());
        let id = body["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let (status, body) = send(
            &st,
            put_json(
                &format!("/apps/{id}"),
                serde_json::json!({
                    "provenance": "cloud",
                    "name": "Renamed",
                    "url": "https://example.com/launch",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");
        assert_eq!(body["provenance"], "cloud");

        let (status, body) = send(&st, delete(&format!("/apps/{id}"))).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["deleted"], true);
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

    /// Replace + delete reject a system app and a seeded self-hosted app with
    /// `AppNotEditable` (409), and an unknown id with `AppNotFound` (404). The
    /// self-hosted body arm covers both: for the system app it's a
    /// provenance mismatch, for the seeded self-hosted app it's the seeded guard.
    #[tokio::test]
    async fn admin_rejects_non_cloud_and_unknown() {
        let st = state();
        let self_hosted_body = serde_json::json!({
            "provenance": "self-hosted",
            "launchPath": "/launch.html",
        });
        for id in ["api-docs", "patient-browser"] {
            let (status, body) = send(
                &st,
                put_json(&format!("/apps/{id}"), self_hosted_body.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "{id} replace");
            assert_eq!(body["error"], "AppNotEditable");

            let (status, body) = send(&st, delete(&format!("/apps/{id}"))).await;
            assert_eq!(status, StatusCode::CONFLICT, "{id} delete");
            assert_eq!(body["error"], "AppNotEditable");
        }

        let (status, body) =
            send(&st, put_json("/apps/no-such-id", self_hosted_body.clone())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");

        let (status, body) = send(&st, delete("/apps/no-such-id")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// A seeded cloud app's content (name / url) is replaceable through the
    /// cloud-admin surface, and the response is the cloud union variant carrying
    /// the new `url`. (`enabled` is not content — see `PUT /home-screen`.)
    #[tokio::test]
    async fn seeded_cloud_app_can_be_edited_and_deleted() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/apps/growth-chart",
                serde_json::json!({
                    "provenance": "cloud",
                    "name": "Renamed",
                    "url": "https://example.com/x",
                    "requiresTunnel": true,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");
        assert_eq!(body["provenance"], "cloud");
        assert_eq!(body["url"], "https://example.com/x");

        let (status, _) = send(&st, delete("/apps/growth-chart")).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// Editability resolves before field validation: a cloud-body PUT to a
    /// **system** app (a provenance mismatch) is `409`, even though its url is
    /// also bad — the mismatch is caught before the url is parsed.
    #[tokio::test]
    async fn non_cloud_replace_with_bad_url_is_409() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/apps/api-docs",
                serde_json::json!({
                    "provenance": "cloud",
                    "name": "x",
                    "url": "javascript:alert(1)",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "AppNotEditable");
    }

    /// A self-hosted app's launch path is editable through `PUT /apps/{id}`:
    /// setting `launchPath` returns the self-hosted union variant, and a
    /// subsequent launch routes to the new path (off the app's own origin, with
    /// `{origin}` → the host API origin). Set up via a direct store insert (no
    /// listener bind) — the launch resolution doesn't need the app served.
    #[tokio::test]
    async fn replace_self_hosted_launch_path_edits_and_launches() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        // First insert lands at the base upload port (8082), no launcher yet.
        st.store
            .insert_self_hosted_app(&upload("My App", "my-app", None))
            .unwrap()
            .expect("inserted");

        let (status, body) = send(
            &st,
            put_json(
                "/apps/my-app",
                serde_json::json!({
                    "provenance": "self-hosted",
                    "launchPath": "/launch.html?launch={launch}&iss={origin}/fhir-r4",
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["provenance"], "self-hosted");
        assert_eq!(body["removable"], true);
        assert_eq!(
            body["launchPath"],
            "/launch.html?launch={launch}&iss={origin}/fhir-r4",
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
    /// root-serving: the launch goes back to the bare origin.
    #[tokio::test]
    async fn replace_self_hosted_clear_launch_path_reverts_to_root() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        st.store
            .insert_self_hosted_app(&upload(
                "My App",
                "my-app",
                Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"),
            ))
            .unwrap()
            .expect("inserted");

        let (status, body) = send(
            &st,
            put_json(
                "/apps/my-app",
                serde_json::json!({ "provenance": "self-hosted", "launchPath": "" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert!(
            body.get("launchPath").is_none(),
            "a cleared launch path is absent from the response",
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
        st.store
            .insert_self_hosted_app(&upload("My App", "my-app", None))
            .unwrap()
            .expect("inserted");
        let (status, body) = send(
            &st,
            put_json(
                "/apps/my-app",
                serde_json::json!({
                    "provenance": "self-hosted",
                    "launchPath": "https://evil.example/launch",
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");
    }

    /// A seeded self-hosted app (patient-browser) is launch-path protected —
    /// `409 AppNotEditable`, same as delete.
    #[tokio::test]
    async fn replace_seeded_self_hosted_launch_path_is_409() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/apps/patient-browser",
                serde_json::json!({ "provenance": "self-hosted", "launchPath": "/launch.html" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "AppNotEditable");
    }

    /// A self-hosted body targeting a cloud app is a provenance mismatch —
    /// `409 AppNotEditable`.
    #[tokio::test]
    async fn replace_cloud_with_self_hosted_body_is_409() {
        let st = state();
        let (status, body) = send(
            &st,
            put_json(
                "/apps/growth-chart",
                serde_json::json!({ "provenance": "self-hosted", "launchPath": "/launch.html" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "AppNotEditable");
    }

    /// A cloud `PUT` fully replaces content: an explicit `subtitle` sets it, and
    /// omitting it (or sending `""`) clears it back to absent.
    #[tokio::test]
    async fn replace_cloud_content_sets_and_clears_subtitle() {
        let st = state();
        let id = {
            let (_, body) = send(
                &st,
                post_multipart(
                    "/apps",
                    &[
                        ("provenance", "cloud"),
                        ("name", "Sub"),
                        ("url", "https://example.com/x"),
                        ("requiresTunnel", "false"),
                        ("subtitle", ""),
                    ],
                    None,
                ),
            )
            .await;
            assert!(
                body.get("subtitle").is_none(),
                "empty subtitle cleared on create"
            );
            body["id"].as_str().unwrap().to_string()
        };
        // A PUT with a subtitle sets it.
        let (_, body) = send(
            &st,
            put_json(
                &format!("/apps/{id}"),
                serde_json::json!({
                    "provenance": "cloud",
                    "name": "Sub",
                    "url": "https://example.com/x",
                    "requiresTunnel": false,
                    "subtitle": "hi",
                }),
            ),
        )
        .await;
        assert_eq!(body["subtitle"], "hi");
        // A PUT omitting the subtitle clears it (full replace).
        let (_, body) = send(
            &st,
            put_json(
                &format!("/apps/{id}"),
                serde_json::json!({
                    "provenance": "cloud",
                    "name": "Sub",
                    "url": "https://example.com/x",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert!(
            body.get("subtitle").is_none(),
            "an omitted subtitle clears on a full replace: {body}",
        );
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

    /// `GET /apps` carries the `removable` flag: cloud + uploaded self-hosted are
    /// removable, system + seeded self-hosted are not.
    #[tokio::test]
    async fn list_apps_reports_removable_flag() {
        let st = state();
        let (_status, body) = send(&st, get("/apps")).await;
        let arr = body.as_array().unwrap();
        let by_id = |id: &str| arr.iter().find(|v| v["id"] == id).expect("row");
        assert_eq!(
            by_id("growth-chart")["removable"],
            true,
            "cloud is removable"
        );
        assert_eq!(
            by_id("patient-browser")["removable"],
            false,
            "seeded self-hosted is not removable",
        );
        assert_eq!(
            by_id("api-docs")["removable"],
            false,
            "system is not removable"
        );
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

    /// A self-hosted upload — `POST /apps` multipart with `provenance=self-hosted`,
    /// the `name`, and the zip `bundle` file part.
    fn post_zip(name: &str, bytes: Vec<u8>) -> Request<Body> {
        post_multipart(
            "/apps",
            &[("provenance", "self-hosted"), ("name", name)],
            Some(("bundle", &bytes)),
        )
    }

    /// The stored `content_folder` for an installed app — the on-disk location
    /// is store-internal (a per-install mint id), so tests resolve it rather
    /// than assuming the slug.
    fn content_folder(st: &Arc<AppsState>, id: &str) -> String {
        st.store
            .find_app(id)
            .unwrap()
            .expect("installed app row")
            .as_self_hosted()
            .expect("self-hosted payload")
            .content_folder
            .clone()
    }

    /// A valid upload installs the app: `200` + `AppListEntry`, a DB row, the
    /// files on disk under the row's `content_folder`, and the tile listed last.
    #[tokio::test]
    async fn upload_installs_a_self_hosted_app() {
        let st = state();
        let bytes = zip_bytes(&[("index.html", b"<h1>UP</h1>")]);
        let (status, body) = send(&st, post_zip("My App", bytes)).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["id"], "my-app");
        assert_eq!(body["provenance"], "self-hosted");
        assert_eq!(body["removable"], true);
        assert_eq!(body["localOnly"], true);

        // The files landed under the row's content_folder — the per-install
        // mint id, deliberately NOT the slug (see the create handler docs).
        let folder = content_folder(&st, "my-app");
        assert_ne!(folder, "my-app", "the folder is the mint id, not the slug");
        let index = st.self_hosted.apps_dir().join(&folder).join("index.html");
        assert_eq!(std::fs::read_to_string(&index).unwrap(), "<h1>UP</h1>");

        // It's listed, last (appended at the tail of the registry).
        let (_s, list) = send(&st, get("/apps")).await;
        let ids: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.last(), Some(&"my-app"), "uploaded app is listed last");
    }

    /// A bundle wrapped in a single top folder serves `index.html` at the root
    /// (the wrapper is hoisted away during extraction).
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

    /// End-to-end: a bundle shipping `launch.html` is installed as a SMART
    /// launcher, and a loopback launch routes to `/launch.html?…` on the app's
    /// own loopback origin with `{launch}` minted and `{origin}` (the `iss`
    /// target) resolved to the *host's* loopback API origin — a different origin
    /// from the app's port. Proves the install-time inference, the stored
    /// template, and the launch-time render are wired together.
    #[tokio::test]
    async fn upload_with_launch_html_launches_the_smart_launcher() {
        let handle = Arc::new(RecordingStubWebviewHandle::default());
        let st = state_with_sink(Arc::clone(&handle) as Arc<dyn OnDeviceWebviewHandle>);
        let bytes = zip_bytes(&[("launch.html", b"<launcher>"), ("index.html", b"<app>")]);
        let (status, body) = send(&st, post_zip("My App", bytes)).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        // First upload lands at the base port (8082).
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

    /// A duplicate name is auto-suffixed (`my-app` → `my-app-2`).
    #[tokio::test]
    async fn upload_auto_suffixes_a_duplicate_name() {
        let st = state();
        let (_s1, first) = send(&st, post_zip("My App", zip_bytes(&[("index.html", b"a")]))).await;
        assert_eq!(first["id"], "my-app");
        let (_s2, second) = send(&st, post_zip("My App", zip_bytes(&[("index.html", b"b")]))).await;
        assert_eq!(second["id"], "my-app-2");
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

    /// An uploaded app is deletable: the rows go, the files go, and it drops off
    /// the list — while the seeded patient-browser stays protected (`409`).
    #[tokio::test]
    async fn uploaded_app_is_deletable_but_seeded_is_protected() {
        let st = state();
        let (_s, created) = send(&st, post_zip("My App", zip_bytes(&[("index.html", b"x")]))).await;
        let id = created["id"].as_str().unwrap().to_owned();
        let dir = st.self_hosted.apps_dir().join(content_folder(&st, &id));
        assert!(dir.exists(), "files present after install");

        let (status, body) = send(&st, delete(&format!("/apps/{id}"))).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["deleted"], true);
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

        // The migration-seeded self-hosted app is not removable.
        let (status, body) = send(&st, delete("/apps/patient-browser")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "AppNotEditable");
    }
}
