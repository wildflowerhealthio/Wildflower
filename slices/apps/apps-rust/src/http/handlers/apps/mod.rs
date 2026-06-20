//! Public `/apps` routes — the unauthenticated read + launch surface the
//! webview consumes. One module per route handler (`list`, `launch`), each
//! exposing a `#[utoipa::path]`-annotated handler; `openapi_router()` collects
//! them so the served routes and the OpenAPI spec come from one place.

mod launch;
mod list;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AppsState;

/// The public `/apps` routes (`GET /apps`, `GET /apps/{id}`) as an
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
    use crate::db::AppsStore;
    use crate::domain::{AppEntry, AppUrl};
    use crate::http::state::AppsState;
    use shared_structures_rust::tunnel_service::{
        OfflineTunnel, TunnelLiveness, TunnelService, TunnelStatus,
    };

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
            .oneshot(get("/apps/no-such-thing"))
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
            .oneshot(get("/apps/patient-browser"))
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
            .oneshot(get("/apps/growth-chart"))
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
            .oneshot(get("/apps/growth-chart"))
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
            .oneshot(get("/apps/app-y"))
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
            .oneshot(get("/apps/app-bad"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
