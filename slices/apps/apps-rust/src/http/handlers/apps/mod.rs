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
    use crate::db::{AppsStore, CreateCustomApp};
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

    #[tokio::test]
    async fn list_apps_returns_all_seeded_bundled_apps() {
        let st = state();
        let (status, body) = send(&st, get("/apps")).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().expect("array");
        // Six bundled entries from the registry; no custom rows yet.
        assert_eq!(arr.len(), crate::domain::BUNDLED_APPS.len());
        let ids: Vec<&str> = arr.iter().map(|v| v["id"].as_str().unwrap()).collect();
        for app in crate::domain::BUNDLED_APPS {
            assert!(ids.contains(&app.id), "missing {}", app.id);
        }
    }

    #[tokio::test]
    async fn list_apps_includes_custom_rows() {
        let st = state();
        st.store
            .create_custom_app(&CreateCustomApp {
                id: "custom-x".into(),
                name: "Custom X".into(),
                url: "https://example.com/x".into(),
                requires_tunnel: false,
            })
            .unwrap();
        let (_status, body) = send(&st, get("/apps")).await;
        let custom = body
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "custom-x")
            .expect("custom row in list");
        assert_eq!(custom["kind"], "custom");
        assert_eq!(custom["name"], "Custom X");
        assert_eq!(custom["subtitle"], "https://example.com/x");
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
    /// SPA can surface a banner. Matches the TS no-op seam exactly.
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
        // Origin is loopback (since we don't have a real tunnel)
        assert!(
            location.contains("iss=http://127.0.0.1:8080/fhir-r4"),
            "expected loopback iss in {location}",
        );
    }

    /// The FHIR-sharing action redirects bare to the served origin.
    #[tokio::test]
    async fn launch_fhir_sharing_redirects_to_origin_with_tunnel_flag() {
        let st = state();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(get("/apps/fhir-sharing"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res
            .headers()
            .get("location")
            .expect("location header")
            .to_str()
            .unwrap();
        // requires_tunnel is true for FHIR sharing, so the flag rides along.
        assert_eq!(location, "http://127.0.0.1:8080?tunnel=unavailable");
    }

    #[tokio::test]
    async fn launch_custom_app_resolves_origin_placeholder() {
        let st = state();
        st.store
            .create_custom_app(&CreateCustomApp {
                id: "custom-y".into(),
                name: "Custom Y".into(),
                url: "{origin}/y".into(),
                requires_tunnel: false,
            })
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

    /// Launch-time defence-in-depth: a custom row whose stored URL resolves
    /// to something we can't safely redirect to (e.g. an `http://` host)
    /// must 404, not 302. The write path already rejects these but the
    /// launch path re-validates the *resolved* URL.
    #[tokio::test]
    async fn launch_custom_app_rejects_resolved_non_https_target() {
        let st = state();
        // Bypass the write-side validator by inserting through the store
        // directly with a URL the validator wouldn't normally accept.
        // SQLite stores it; the launch path's `isLaunchableUrl` rejects it.
        st.store
            .conn()
            .lock()
            .execute(
                "INSERT INTO apps (id, kind, enabled, custom_name, custom_url, custom_requires_tunnel) \
                 VALUES ('custom-bad', 'custom', 1, 'Bad', 'http://evil.example.com', 0)",
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
