//! Public `/apps` routes — the unauthenticated read + launch surface the
//! webview consumes. One module per route handler (`list`, `launch`), each
//! exposing a `#[utoipa::path]`-annotated handler; `openapi_router()` collects
//! them so the served routes and the OpenAPI spec come from one place.
//!
//! `GET /apps` lists; `POST /apps/{id}` launches (302 to the resolved URL, or
//! 204 when a host [`LaunchSink`](crate::LaunchSink) takes the side-effect).

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
    use std::sync::{Arc, Mutex};

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::db::AppsStore;
    use crate::domain::{AppEntry, AppUrl};
    use crate::http::state::AppsState;
    use crate::LaunchSink;
    use shared_structures_rust::tunnel_service::{
        OfflineTunnel, TunnelLiveness, TunnelService, TunnelStatus,
    };

    /// A [`LaunchSink`] stub that records the URLs it's handed, so a test can
    /// assert the handler resolved the target and routed it to the sink (and
    /// returned `204`) instead of redirecting.
    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<String>>);

    impl LaunchSink for RecordingSink {
        fn open(&self, _app: &AppEntry, url: &str) {
            self.0.lock().expect("sink mutex").push(url.to_owned());
        }
    }

    /// A `TunnelService` stub for a tunnel that's up and verified at `origin` —
    /// the success counterpart to the shared [`OfflineTunnel`], which already
    /// models the can't-reach case (`try_start` fails, state stays `Off`).
    struct StubTunnel(String);

    #[async_trait::async_trait]
    impl TunnelService for StubTunnel {
        fn current_origin(&self) -> String {
            self.0.clone()
        }
        async fn try_start(&self) -> Result<String, String> {
            Ok(self.0.clone())
        }
        fn subscribe(&self) -> tokio::sync::watch::Receiver<TunnelLiveness> {
            tokio::sync::watch::channel(TunnelLiveness {
                settings_revision: None,
                status: TunnelStatus::Verified,
                origin: self.0.clone(),
                error: None,
                dial_attempts: 0,
            })
            .1
        }
    }

    fn tunnel_at(origin: &str) -> Arc<dyn TunnelService> {
        Arc::new(StubTunnel(origin.to_string()))
    }

    fn tunnel_unavailable() -> Arc<dyn TunnelService> {
        Arc::new(OfflineTunnel::new("http://127.0.0.1:8080"))
    }

    /// The served public router, state not yet applied — the spec half of
    /// `split_for_parts` is irrelevant here.
    fn router() -> Router<Arc<AppsState>> {
        openapi_router().split_for_parts().0
    }

    fn state() -> Arc<AppsState> {
        state_with_tunnel(tunnel_unavailable())
    }

    fn state_with_tunnel(tunnel: Arc<dyn TunnelService>) -> Arc<AppsState> {
        let store = AppsStore::open_in_memory().expect("store");
        Arc::new(AppsState::new(store, "http://127.0.0.1:8080", tunnel))
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
    /// `POST /apps/{id}` carrying `x-public-origin` plus `x-forwarded-proto`,
    /// the same header pair `gatekeeper_rust::served_origin_for` uses to resolve
    /// the served origin. Reads as a remote caller rather than the local
    /// loopback webview.
    fn post_forwarded(uri: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("x-public-origin", "demo.example.com")
            .header("x-forwarded-proto", "https")
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

    #[tokio::test]
    async fn list_apps_includes_inserted_rows() {
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
        assert_eq!(found["url"], "https://example.com/x");
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

    /// A seeded app whose URL template substitutes `{origin}` resolves to a
    /// same-origin redirect.
    #[tokio::test]
    async fn launch_seeded_app_redirects_to_built_url() {
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
        assert_eq!(
            location,
            "http://127.0.0.1:8080/installed-apps/patient-browser/index.html"
        );
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

    /// With a [`LaunchSink`] installed, a launch hands the resolved URL to the
    /// sink and returns `204` (no redirect) — the host owns the side-effect.
    #[tokio::test]
    async fn launch_with_sink_204s_and_routes_the_url_to_the_sink() {
        let sink = Arc::new(RecordingSink::default());
        let store = AppsStore::open_in_memory().expect("store");
        let st = Arc::new(
            AppsState::new(store, "http://127.0.0.1:8080", tunnel_unavailable())
                .with_launch_sink(Arc::clone(&sink) as Arc<dyn LaunchSink>),
        );
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
            vec!["http://127.0.0.1:8080/installed-apps/patient-browser/index.html".to_string()],
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
    /// header contract.
    #[tokio::test]
    async fn launch_forwarded_request_redirects_to_the_served_public_origin() {
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
        assert_eq!(
            location,
            "https://demo.example.com/installed-apps/patient-browser/index.html",
            "a forwarded launch must redirect to the public origin (x-forwarded-proto://x-public-origin), not loopback",
        );
    }

    /// A sink is installed, but the request is forwarded by the relay/tunnel
    /// (a *remote* caller): the host-side popup would be invisible to them, so
    /// the launch `302`s instead of `204`ing — and the sink is NOT invoked.
    #[tokio::test]
    async fn launch_with_sink_but_forwarded_request_302s_without_invoking_the_sink() {
        let sink = Arc::new(RecordingSink::default());
        let store = AppsStore::open_in_memory().expect("store");
        let st = Arc::new(
            AppsState::new(store, "http://127.0.0.1:8080", tunnel_unavailable())
                .with_launch_sink(Arc::clone(&sink) as Arc<dyn LaunchSink>),
        );
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post_forwarded("/apps/patient-browser"))
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
