//! Public `/apps` routes — the unauthenticated read + launch surface the
//! webview consumes. One module per route handler (`list`, `launch`), each
//! exposing a `MethodRouter`; `router()` is the only path table.

mod launch;
mod list;

use std::sync::Arc;

use axum::Router;

use crate::http::state::AppsState;

pub(super) fn router() -> Router<Arc<AppsState>> {
    Router::new()
        .route("/apps", list::route())
        .route("/apps/{id}", launch::route())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::db::AppsStore;
    use crate::domain::{AppEntry, AppKind};
    use crate::http::state::AppsState;

    fn state() -> Arc<AppsState> {
        let store = AppsStore::open_in_memory().expect("store");
        Arc::new(AppsState::new(store, "http://127.0.0.1:8080"))
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

    fn custom(id: &str, url: &str) -> AppEntry {
        AppEntry {
            id: id.to_owned(),
            kind: AppKind::Custom,
            enabled: true,
            name: id.to_owned(),
            subtitle: None,
            url: url.to_owned(),
            requires_tunnel: false,
        }
    }

    #[tokio::test]
    async fn list_apps_returns_all_seeded_bundled_apps() {
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
    async fn list_apps_includes_custom_rows() {
        let st = state();
        st.store
            .insert_app(&custom("custom-x", "https://example.com/x"))
            .unwrap();
        let (_status, body) = send(&st, get("/apps")).await;
        let found = body
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "custom-x")
            .expect("custom row in list");
        assert_eq!(found["kind"], "custom");
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

    /// A seeded bundled app whose URL template substitutes `{origin}`
    /// resolves to a same-origin redirect.
    #[tokio::test]
    async fn launch_bundled_redirects_to_built_url() {
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

    /// A `requires_tunnel` bundled launch redirects to the loopback origin
    /// (no real tunnel seam yet) with the `tunnel=unavailable` flag so the
    /// SPA can surface a banner.
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

    #[tokio::test]
    async fn launch_custom_app_resolves_origin_placeholder() {
        let st = state();
        st.store
            .insert_app(&custom("custom-y", "{origin}/y"))
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(get("/apps/custom-y"))
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

    /// Launch-time defence-in-depth: a row whose stored URL resolves to a
    /// non-https foreign target must 404, not 302. The write path rejects
    /// these on input but the launch path re-validates the *resolved* URL.
    #[tokio::test]
    async fn launch_rejects_resolved_non_https_target() {
        let st = state();
        // Bypass the write-side validator by inserting through SQL directly
        // with a URL the validator wouldn't normally accept.
        st.store
            .conn()
            .lock()
            .execute(
                "INSERT INTO apps (id, kind, enabled, name, subtitle, url, requires_tunnel) \
                 VALUES ('custom-bad', 'custom', 1, 'Bad', NULL, 'http://evil.example.com', 0)",
                [],
            )
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(get("/apps/custom-bad"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}
