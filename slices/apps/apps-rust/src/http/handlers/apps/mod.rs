//! Public `/apps` routes — the unauthenticated read + launch surface the
//! webview consumes. One module per route handler (`list`, `launch`), each
//! exposing a `#[utoipa::path]`-annotated handler; `openapi_router()` collects
//! them so the served routes and the OpenAPI spec come from one place.
//!
//! `GET /apps` lists; `POST /apps/{id}` launches (302 to the resolved URL, or
//! 204 when a host [`LaunchSink`](crate::LaunchSink) takes the
//! side-effect).

mod launch;
mod list;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AppsState;

/// The public `/apps` routes (`GET /apps`, `POST /apps/{id}`) as an
/// `OpenApiRouter`. Mounted by [`crate::http`]; `routes!` reads each handler's
/// `#[utoipa::path]` for its method + path.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new()
        .routes(routes!(list::handle_list_apps))
        .routes(routes!(launch::handle_launch_app))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::domain::{AppEntry, AppUrl};
    use crate::http::handlers::test_utils::{
        state, state_with_sink, state_with_tunnel, tunnel_at, tunnel_with_public_host, RecordingSink,
    };
    use crate::http::state::AppsState;
    use crate::LaunchSink;

    /// The served public router, state not yet applied — the spec half of
    /// `split_for_parts` is irrelevant here.
    fn router() -> Router<Arc<AppsState>> {
        openapi_router().split_for_parts().0
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

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    /// A launch request — `POST /apps/{id}` with an empty body. No forwarding
    /// header, so it reads as a direct loopback (local) caller.
    fn post(uri: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    /// A launch request as the trusted front (relay/tunnel) would forward it:
    /// `POST /apps/{id}` carrying the RFC 7239 `Forwarded` header with the
    /// public `host`/`proto` — the same header
    /// `shared_structures_rust::served_origin::request_provenance` reads to
    /// resolve the served origin. Reads as a remote caller rather than the
    /// local loopback webview.
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

    fn app(id: &str, url: AppUrl) -> AppEntry {
        AppEntry {
            id: id.to_owned(),
            enabled: true,
            name: id.to_owned(),
            subtitle: None,
            url,
            requires_tunnel: false,
        }
    }

    fn external(url: &str) -> AppUrl {
        AppUrl::External(url.to_owned())
    }

    #[tokio::test]
    async fn list_apps_returns_all_seeded_apps() {
        let st = state();
        let (status, body) = send(&st, get("/apps")).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().expect("array");
        let ids: Vec<&str> = arr.iter().map(|v| v["id"].as_str().unwrap()).collect();
        for expected in [
            "patient-browser",
            "api-view",
            "api-docs",
            "growth-chart",
            "medication-viewer",
        ] {
            assert!(ids.contains(&expected), "missing {expected} in {ids:?}");
        }
    }

    /// `GET /apps` deliberately omits `url` (the launch endpoint resolves
    /// it per-request). An inserted row still appears in the list under
    /// its id; the `url` it was written with shows up on launch / admin
    /// responses, not here.
    #[tokio::test]
    async fn list_apps_includes_inserted_rows_without_url() {
        let st = state();
        st.store
            .insert_app(&app("app-x", external("https://example.com/x")))
            .unwrap();
        let (_status, body) = send(&st, get("/apps")).await;
        let found = body
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "app-x")
            .expect("inserted row in list");
        assert!(
            found.get("url").is_none(),
            "GET /apps must not expose url, got {found}",
        );
        assert_eq!(found["name"], "app-x");
    }

    #[tokio::test]
    async fn launch_unknown_id_is_404() {
        let st = state();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/no-such-thing"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// A seeded internal app launched by a loopback caller resolves to its
    /// dedicated loopback origin — `http://{LOOPBACK_HOST}:{port}/`, built
    /// from host config + the row's `port`. No `{origin}` substitution, no
    /// tunnel involvement.
    #[tokio::test]
    async fn launch_internal_app_redirects_to_its_dedicated_loopback_origin() {
        let st = state();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/patient-browser"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        assert_eq!(location, "http://127.0.0.1:8081/");
    }

    /// A forwarded launch of an internal app with `public_host` configured
    /// redirects to the public subdomain — the URL a remote browser can
    /// actually reach through the relay. Matches the subdomain shape the
    /// host's inbound dispatch routes back to the same per-app router.
    #[tokio::test]
    async fn launch_internal_app_forwarded_redirects_to_the_public_subdomain() {
        let st = state_with_tunnel(tunnel_with_public_host("demo.example.com"));
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post_forwarded("/apps/patient-browser"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        assert_eq!(location, "https://patient-browser.demo.example.com/");
    }

    /// A forwarded launch of an internal app falls back to the loopback URL
    /// when `public_host` isn't configured — the redirect is degraded (a
    /// remote browser can't follow it) but the catalogue stays consistent
    /// and the launch handler doesn't error.
    #[tokio::test]
    async fn launch_internal_app_forwarded_falls_back_to_loopback_without_public_host() {
        let st = state();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post_forwarded("/apps/patient-browser"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        assert_eq!(location, "http://127.0.0.1:8081/");
    }

    /// When the tunnel can't be reached, a `requires_tunnel` launch falls back
    /// to the loopback origin with the `tunnel=unavailable` flag so the SPA can
    /// surface a banner.
    #[tokio::test]
    async fn launch_growth_chart_appends_tunnel_unavailable() {
        let st = state();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/growth-chart"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        assert!(
            location.contains("tunnel=unavailable"),
            "expected tunnel=unavailable in {location}",
        );
        assert!(
            location.contains("iss=http://127.0.0.1:8080/fhir-r4"),
            "expected loopback iss in {location}",
        );
    }

    /// When the tunnel service starts and returns a verified origin, a
    /// `requires_tunnel` launch redirects there (no `tunnel=unavailable`).
    #[tokio::test]
    async fn launch_growth_chart_resolves_to_the_verified_tunnel_origin() {
        let st = state_with_tunnel(tunnel_at("https://dev1.example.com"));
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/growth-chart"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        assert!(
            location.contains("iss=https://dev1.example.com/fhir-r4"),
            "expected the verified tunnel origin in {location}",
        );
        assert!(
            !location.contains("tunnel=unavailable"),
            "a reachable tunnel must not flag unavailable: {location}",
        );
    }

    #[tokio::test]
    async fn launch_app_resolves_origin_placeholder() {
        let st = state();
        st.store
            .insert_app(&app("app-y", AppUrl::OriginRelative("/y".to_owned())))
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/app-y"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        assert_eq!(location, "http://127.0.0.1:8080/y");
    }

    /// A row whose stored `url` no longer parses — only reachable by bypassing
    /// the write-side validator with raw SQL — fails the typed read
    /// (`AppUrl`'s `FromSql`), so the launch surfaces a logged 500 rather than
    /// ever redirecting to the unsafe target.
    #[tokio::test]
    async fn launch_rejects_unparseable_stored_url_as_500() {
        let st = state();
        st.store
            .conn()
            .lock()
            .execute(
                "INSERT INTO apps (id, enabled, name, subtitle, url, requires_tunnel) \
                 VALUES ('app-bad', 1, 'Bad', NULL, 'http://evil.example.com', 0)",
                [],
            )
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/app-bad"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// With an [`LaunchSink`] installed, a launch hands the resolved URL
    /// to the sink and returns `204` (no redirect) — the host owns the side-effect.
    /// Exercised against the internal `patient-browser` row so the assertion
    /// pins the URL the sink receives to a fixed value (no random `{launch}`
    /// nonce).
    #[tokio::test]
    async fn launch_with_sink_204s_and_routes_the_url_to_the_sink() {
        let sink = Arc::new(RecordingSink::default());
        let st = state_with_sink(Arc::clone(&sink) as Arc<dyn LaunchSink>);
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/patient-browser"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(
            res.headers().get("location").is_none(),
            "a sink launch must not carry a Location redirect",
        );
        let opened = sink.0.lock().expect("sink mutex").clone();
        assert_eq!(
            opened,
            vec!["http://127.0.0.1:8081/".to_string()],
            "the sink must receive the same resolved URL the redirect path would 302 to",
        );
    }

    /// Without a sink (the web/standalone default), a launch still `302`s to
    /// the resolved URL — the counterpart to the sink test above.
    #[tokio::test]
    async fn launch_without_sink_still_302s() {
        let st = state();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post("/apps/patient-browser"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        assert!(
            res.headers().get("location").is_some(),
            "no sink means the browser-following redirect path",
        );
    }

    /// A non-tunnel launch forwarded by the relay/tunnel resolves `{origin}`
    /// against the *served* (public) origin, not loopback — otherwise the
    /// browser would chase a `Location: http://127.0.0.1:…` it can't reach
    /// from outside the host. Mirrors `gatekeeper_rust::served_origin_for`'s
    /// header contract. Exercised against an `{origin}`-templated external
    /// row (patient-browser moved out to the internal store, which is
    /// loopback-only by construction and so doesn't exercise the
    /// served-origin substitution).
    #[tokio::test]
    async fn launch_forwarded_request_redirects_to_the_served_public_origin() {
        let st = state();
        st.store
            .insert_app(&app("app-y", AppUrl::OriginRelative("/y".to_owned())))
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post_forwarded("/apps/app-y"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        assert_eq!(
            location, "https://demo.example.com/y",
            "a forwarded launch must redirect to the public origin (the Forwarded host/proto), not loopback",
        );
    }

    /// A sink is installed, but the request is forwarded by the relay/tunnel
    /// (a *remote* caller): the host-side popup would be invisible to them, so
    /// the launch `302`s instead of `204`ing — and the sink is NOT invoked.
    /// Exercised against an external `{origin}` app (an internal-app launch
    /// would still 302, but to its fixed loopback origin — which a remote
    /// browser can't reach; the assertion-friendly substitution path is the
    /// external one).
    #[tokio::test]
    async fn launch_with_sink_but_forwarded_request_302s_without_invoking_the_sink() {
        let sink = Arc::new(RecordingSink::default());
        let st = state_with_sink(Arc::clone(&sink) as Arc<dyn LaunchSink>);
        st.store
            .insert_app(&app("app-y", AppUrl::OriginRelative("/y".to_owned())))
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post_forwarded("/apps/app-y"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        assert!(
            res.headers().get("location").is_some(),
            "a forwarded request takes the redirect path even with a sink installed",
        );
        assert!(
            sink.0.lock().expect("sink mutex").is_empty(),
            "the sink must not open a popup for a remote (forwarded) caller",
        );
    }
}
