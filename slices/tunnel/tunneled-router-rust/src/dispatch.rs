//! The forwarded-request dispatch middleware and the state it reads.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};
use shared_structures_rust::tunnel_service::TunnelService;
use tower::util::ServiceExt;

use crate::host_match::match_forwarded_origin;

/// State threaded into [`maybe_dispatch_to_subdomain`]: the per-route routers
/// (keyed on id) plus the tunnel handle, read at request time so a settings
/// update through the `/tunnel` admin surface takes effect without a restart.
pub(crate) struct SubdomainDispatchState {
    routers: HashMap<String, Router>,
    tunnel: Arc<dyn TunnelService>,
}

impl SubdomainDispatchState {
    pub(crate) fn new(routers: HashMap<String, Router>, tunnel: Arc<dyn TunnelService>) -> Self {
        Self { routers, tunnel }
    }
}

/// Tower middleware: if the inbound request is a forwarded request whose
/// `Forwarded` host matches `<id>.<public_host>` for a registered route,
/// dispatch into that route's router and return its response. Otherwise run the
/// wrapped router via `next`.
///
/// Calling a cloned [`Router`] as a `tower::Service` via [`ServiceExt::oneshot`]
/// is the standard axum integration idiom — the [`Router`] future is infallible
/// so the `Result` is destructured without panicking.
pub(crate) async fn maybe_dispatch_to_subdomain(
    State(state): State<Arc<SubdomainDispatchState>>,
    req: Request,
    next: Next,
) -> Response {
    let RequestProvenance::Forwarded { origin } = request_provenance(req.headers()) else {
        return next.run(req).await;
    };
    let Some(public_host) = state.tunnel.current_public_host() else {
        // Public host unconfigured: no inbound subdomain can match. Fall
        // through to the wrapped router.
        return next.run(req).await;
    };
    let Some(app_id) =
        match_forwarded_origin(&origin, &public_host, |id| state.routers.contains_key(id))
    else {
        return next.run(req).await;
    };
    let router = state
        .routers
        .get(&app_id)
        .expect("match_forwarded_origin only returns ids contains_key returned true for")
        .clone();
    router
        .oneshot(req)
        .await
        .expect("axum Router::Future is infallible")
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::{to_bytes, Body};
    use axum::http::{HeaderName, HeaderValue, StatusCode};
    use axum::routing::get;
    use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelStatus};
    use tokio::sync::watch;
    use tower::util::ServiceExt;

    /// `TunnelService` stub whose `current_public_host` is whatever the test
    /// fixed it to (mirrors `TunnelControl`: a configured setting independent of
    /// the daemon's liveness).
    struct StubTunnel {
        public_host: Option<String>,
    }

    #[async_trait::async_trait]
    impl TunnelService for StubTunnel {
        fn current_origin(&self) -> String {
            "http://127.0.0.1:8080".to_owned()
        }
        fn current_public_host(&self) -> Option<String> {
            self.public_host.clone()
        }
        async fn try_start(&self) -> Result<String, String> {
            Err("not used".to_owned())
        }
        fn subscribe(&self) -> watch::Receiver<TunnelLiveness> {
            watch::channel(TunnelLiveness {
                settings_revision: None,
                status: TunnelStatus::Off,
                origin: self.current_origin(),
                error: None,
                dial_attempts: 0,
            })
            .1
        }
    }

    /// A tiny per-app router that responds `INTERNAL: <id>` so the dispatch path
    /// is distinguishable from the API path in assertions.
    fn app_router(id: &str) -> Router {
        let id = id.to_owned();
        Router::new().fallback(get(move || {
            let id = id.clone();
            async move { format!("INTERNAL: {id}") }
        }))
    }

    fn api_router() -> Router {
        Router::new().fallback(get(|| async { "API" }))
    }

    /// Wrap `api_router` with the dispatch middleware — the same wiring
    /// [`crate::builder::SubdomainDispatch::wrap`] does, minus the port binding
    /// (so tests don't open sockets).
    fn dispatch_router(routers: HashMap<String, Router>, public_host: Option<&str>) -> Router {
        let tunnel: Arc<dyn TunnelService> = Arc::new(StubTunnel {
            public_host: public_host.map(str::to_owned),
        });
        let state = Arc::new(SubdomainDispatchState::new(routers, tunnel));
        api_router().layer(axum::middleware::from_fn_with_state(
            state,
            maybe_dispatch_to_subdomain,
        ))
    }

    fn one_router(id: &str) -> HashMap<String, Router> {
        HashMap::from([(id.to_owned(), app_router(id))])
    }

    async fn body_string(res: Response) -> String {
        String::from_utf8(to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap()
    }

    fn request(headers: &[(&'static str, &str)]) -> Request {
        let mut req = Request::get("/").body(Body::empty()).unwrap();
        for (name, value) in headers {
            req.headers_mut().insert(
                HeaderName::from_static(name),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        req
    }

    /// A forwarded request whose `Forwarded` host matches `<id>.<public_host>`
    /// for a known id is dispatched to the per-app router; the API never sees it.
    #[tokio::test]
    async fn forwarded_subdomain_routes_to_the_app() {
        let router = dispatch_router(one_router("patient-browser"), Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "forwarded",
                "host=patient-browser.demo.example.com;proto=https",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_string(res).await, "INTERNAL: patient-browser");
    }

    /// A forwarded request to the apex host (no matching `<id>.<public_host>`)
    /// falls through to the wrapped API.
    #[tokio::test]
    async fn forwarded_request_to_the_apex_host_falls_through() {
        let router = dispatch_router(one_router("patient-browser"), Some("demo.example.com"));
        let res = router
            .oneshot(request(&[("forwarded", "host=demo.example.com;proto=https")]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// A forwarded subdomain that isn't a known id falls through.
    #[tokio::test]
    async fn unknown_subdomain_falls_through() {
        let router = dispatch_router(one_router("patient-browser"), Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "forwarded",
                "host=no-such-app.demo.example.com;proto=https",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// A direct loopback request (no `Forwarded` header) always goes to the API
    /// — local callers already have a dedicated `:port` listener per app.
    #[tokio::test]
    async fn unforwarded_request_falls_through() {
        let router = dispatch_router(one_router("patient-browser"), Some("demo.example.com"));
        let res = router.oneshot(request(&[])).await.expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// When `current_public_host` is `None`, no forwarded request can match.
    #[tokio::test]
    async fn no_configured_public_host_means_no_dispatch() {
        let router = dispatch_router(one_router("patient-browser"), None);
        let res = router
            .oneshot(request(&[(
                "forwarded",
                "host=patient-browser.demo.example.com;proto=https",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// The strict-match guard: a host whose non-subdomain part isn't the
    /// configured public host (`patient-browser.attacker.com`) falls through.
    #[tokio::test]
    async fn rest_of_host_must_equal_the_configured_public_host() {
        let router = dispatch_router(one_router("patient-browser"), Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "forwarded",
                "host=patient-browser.attacker.com;proto=https",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// A port on the inbound host doesn't break the match.
    #[tokio::test]
    async fn inbound_port_does_not_break_match() {
        let router = dispatch_router(one_router("patient-browser"), Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "forwarded",
                "host=patient-browser.demo.example.com:8443;proto=https",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "INTERNAL: patient-browser");
    }

    /// A port on the *configured* public host doesn't break the match either —
    /// the symmetric port fix (a non-443 relay deploy carries one).
    #[tokio::test]
    async fn configured_port_does_not_break_match() {
        let router = dispatch_router(one_router("patient-browser"), Some("demo.example.com:8443"));
        let res = router
            .oneshot(request(&[(
                "forwarded",
                "host=patient-browser.demo.example.com:8443;proto=https",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "INTERNAL: patient-browser");
    }
}
