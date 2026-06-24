//! Forwarded-host dispatch — route an inbound forwarded request to its
//! internal app's static file router when the request's `x-public-origin`
//! identifies a known internal app by subdomain.
//!
//! Each internal app already has its own dedicated loopback origin
//! (`http://{loopback}:{port}/`) bound by [`crate::lib`]'s per-app
//! `TcpListener`. For requests that come in through the rathole tunnel —
//! landing on the main API port — there is no per-app socket; the relay
//! advertises one public host (e.g. `demo.example.com`) and uses
//! subdomains to disambiguate. So we dispatch in software: when the
//! forwarded request's `x-public-origin` is exactly
//! `<internal-app-id>.<configured-public-host>` (port-insensitive), the
//! request is handed straight to that app's router; otherwise the regular
//! API stack runs.
//!
//! ## Match strictness
//!
//! The match is `x-public-origin == "<app-id>.<configured-public-host>"`
//! exactly (case-insensitive on host, port ignored): the leftmost label
//! must be a known internal-app id, and the rest must equal the
//! `TunnelService::current_public_host`. This means a misconfigured front
//! advertising `patient-browser.attacker.com` cannot shadow the internal
//! app — the rest of the host wouldn't match. When `current_public_host`
//! is `None` (the relay isn't configured), no forwarded request is ever
//! dispatched here; the request falls through to the regular API like
//! today.
//!
//! ## What this does NOT do
//!
//! Launch redirects still point to the loopback origin. A launch returning
//! `Location: https://patient-browser.<public-host>/` so a remote browser
//! could follow it is a follow-up; this layer only handles *inbound* relay
//! traffic, not where launches send people.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};
use shared_structures_rust::tunnel_service::TunnelService;
use tower::util::ServiceExt;

/// State threaded into [`maybe_dispatch_to_internal_subdomain`]: the
/// per-internal-app routers (keyed on id) plus the tunnel handle used to
/// read the live public-host setting.
pub(crate) struct SubdomainDispatchState {
    routers: HashMap<String, Router>,
    tunnel: Arc<dyn TunnelService>,
}

impl SubdomainDispatchState {
    /// Build the dispatch state. `routers` must already carry one router
    /// per internal app id; `tunnel` is read at request time so a settings
    /// update through the `/tunnel` admin surface takes effect without a
    /// restart.
    pub(crate) fn new(routers: HashMap<String, Router>, tunnel: Arc<dyn TunnelService>) -> Self {
        Self { routers, tunnel }
    }
}

/// Tower middleware: if the inbound request is a forwarded request whose
/// `x-public-origin` matches `<internal-app-id>.<configured-public-host>`,
/// dispatch into the per-app router and return its response. Otherwise
/// run the main API router via `next`.
///
/// Calling a cloned [`Router`] as a `tower::Service` via
/// [`ServiceExt::oneshot`] is the standard axum integration-test idiom —
/// the [`Router::Future`] is infallible so the `Result` is destructured
/// without panicking.
pub(crate) async fn maybe_dispatch_to_internal_subdomain(
    State(state): State<Arc<SubdomainDispatchState>>,
    req: Request,
    next: Next,
) -> Response {
    let RequestProvenance::Forwarded { origin } = request_provenance(req.headers()) else {
        return next.run(req).await;
    };
    let Some(public_host) = state.tunnel.current_public_host() else {
        // Public host unconfigured: no inbound subdomain can match. Fall
        // through to the regular API.
        return next.run(req).await;
    };
    let Some(host) = strip_scheme(&origin) else {
        return next.run(req).await;
    };
    let Some(app_id) = match_internal_subdomain(host, &public_host, |id| {
        state.routers.contains_key(id)
    }) else {
        return next.run(req).await;
    };
    let router = state
        .routers
        .get(&app_id)
        .expect("match_internal_subdomain only returns ids contains_key returned true for")
        .clone();
    router
        .oneshot(req)
        .await
        .expect("axum Router::Future is infallible")
}

/// Strip a `scheme://` prefix from `origin`, returning the host[:port] tail.
/// `None` for an empty tail (defensive: `request_provenance` already
/// validated the host shape).
fn strip_scheme(origin: &str) -> Option<&str> {
    origin
        .split_once("://")
        .map(|(_, tail)| tail)
        .filter(|tail| !tail.is_empty())
}

/// Match `<app-id>.<public-host>` (port-insensitive on the inbound side,
/// case-insensitive on host). Returns `Some(app_id)` when the inbound host
/// is exactly `<id>.<public_host>` for some `id` accepted by `is_known_id`.
///
/// `is_known_id` is a callback rather than the router map directly so this
/// function stays pure-string and easy to unit-test.
fn match_internal_subdomain(
    inbound_host: &str,
    public_host: &str,
    is_known_id: impl Fn(&str) -> bool,
) -> Option<String> {
    // Strip an optional `:port` suffix — IPv6 has its own bracketed form
    // (`[::1]:8080`) which only contains a `:` inside the brackets, but a
    // public host is normally a DNS name, so a single rightmost `:` after
    // the bracket closes (or in a name with no `[`) is the port.
    let host_no_port = match (inbound_host.rfind(']'), inbound_host.rfind(':')) {
        // IPv6 with port: `[…]:port` — strip after the bracket-closing `]`.
        (Some(bracket), Some(colon)) if colon > bracket => &inbound_host[..colon],
        // IPv6 without port: keep verbatim.
        (Some(_), _) => inbound_host,
        // DNS name with port.
        (None, Some(colon)) => &inbound_host[..colon],
        // DNS name without port.
        (None, None) => inbound_host,
    };
    let inbound_lower = host_no_port.to_ascii_lowercase();
    let public_lower = public_host.to_ascii_lowercase();
    let (leftmost, rest) = inbound_lower.split_once('.')?;
    if rest != public_lower {
        return None;
    }
    if !is_known_id(leftmost) {
        return None;
    }
    Some(leftmost.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    use axum::body::{to_bytes, Body};
    use axum::http::{HeaderName, HeaderValue, StatusCode};
    use axum::routing::get;
    use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelStatus};
    use tokio::sync::watch;

    /// `TunnelService` stub whose `current_public_host` is what the test
    /// fixed it to (mirrors the live `TunnelControl` behavior: a configured
    /// setting that is independent of the daemon's liveness).
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

    /// Build a tiny per-app router that responds with `INTERNAL: <id>` so
    /// the dispatch path is distinguishable from the API path in
    /// assertions.
    fn internal_router(id: &str) -> Router {
        let id = id.to_owned();
        Router::new().fallback(get(move || {
            let id = id.clone();
            async move { format!("INTERNAL: {id}") }
        }))
    }

    fn api_router() -> Router {
        Router::new().fallback(get(|| async { "API" }))
    }

    fn dispatch_router(
        routers: HashMap<String, Router>,
        public_host: Option<&str>,
    ) -> Router {
        let tunnel: Arc<dyn TunnelService> = Arc::new(StubTunnel {
            public_host: public_host.map(str::to_owned),
        });
        let state = Arc::new(SubdomainDispatchState::new(routers, tunnel));
        api_router().layer(axum::middleware::from_fn_with_state(
            state,
            maybe_dispatch_to_internal_subdomain,
        ))
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

    /// A forwarded request whose `x-public-origin` matches
    /// `<id>.<public-host>` for a known internal id is dispatched to the
    /// per-app router; the API never sees it.
    #[tokio::test]
    async fn forwarded_subdomain_routes_to_the_internal_app() {
        let mut routers = HashMap::new();
        routers.insert("patient-browser".to_owned(), internal_router("patient-browser"));
        let router = dispatch_router(routers, Some("demo.example.com"));
        let res = router
            .oneshot(request(&[
                ("x-public-origin", "patient-browser.demo.example.com"),
                ("x-forwarded-proto", "https"),
            ]))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_string(res).await, "INTERNAL: patient-browser");
    }

    /// A forwarded request whose host doesn't match any
    /// `<id>.<public_host>` shape falls through to the regular API.
    #[tokio::test]
    async fn forwarded_request_to_the_apex_host_falls_through_to_the_api() {
        let routers = HashMap::from([(
            "patient-browser".to_owned(),
            internal_router("patient-browser"),
        )]);
        let router = dispatch_router(routers, Some("demo.example.com"));
        let res = router
            .oneshot(request(&[("x-public-origin", "demo.example.com")]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// A forwarded request whose subdomain isn't a known internal-app id
    /// falls through. (E.g. an admin subdomain, or a typo.)
    #[tokio::test]
    async fn unknown_subdomain_falls_through_to_the_api() {
        let routers = HashMap::from([(
            "patient-browser".to_owned(),
            internal_router("patient-browser"),
        )]);
        let router = dispatch_router(routers, Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "x-public-origin",
                "no-such-app.demo.example.com",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// A direct loopback request (no `x-public-origin`) ALWAYS goes to the
    /// API, even if the path/host could otherwise look like an internal
    /// subdomain. Local requests already have a dedicated `:port` listener
    /// for the internal app.
    #[tokio::test]
    async fn unforwarded_request_falls_through_to_the_api() {
        let routers = HashMap::from([(
            "patient-browser".to_owned(),
            internal_router("patient-browser"),
        )]);
        let router = dispatch_router(routers, Some("demo.example.com"));
        let res = router.oneshot(request(&[])).await.expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// When `current_public_host` is `None`, no forwarded request can
    /// match — the relay isn't configured.
    #[tokio::test]
    async fn no_configured_public_host_means_no_dispatch() {
        let routers = HashMap::from([(
            "patient-browser".to_owned(),
            internal_router("patient-browser"),
        )]);
        let router = dispatch_router(routers, None);
        let res = router
            .oneshot(request(&[(
                "x-public-origin",
                "patient-browser.demo.example.com",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// A forwarded request that would otherwise match but the host's
    /// non-subdomain part doesn't equal the configured public host
    /// (`patient-browser.attacker.com` while the relay is for
    /// `demo.example.com`) falls through to the API — the strict-match
    /// guard.
    #[tokio::test]
    async fn rest_of_host_must_equal_the_configured_public_host() {
        let routers = HashMap::from([(
            "patient-browser".to_owned(),
            internal_router("patient-browser"),
        )]);
        let router = dispatch_router(routers, Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "x-public-origin",
                "patient-browser.attacker.com",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "API");
    }

    /// Match is case-insensitive on the host — DNS hostnames are
    /// canonically case-insensitive.
    #[tokio::test]
    async fn host_match_is_case_insensitive() {
        let routers = HashMap::from([(
            "patient-browser".to_owned(),
            internal_router("patient-browser"),
        )]);
        let router = dispatch_router(routers, Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "x-public-origin",
                "Patient-Browser.DEMO.example.com",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "INTERNAL: patient-browser");
    }

    /// A port on the inbound host is ignored for matching — the
    /// reverse-proxy's public origin may carry one.
    #[tokio::test]
    async fn inbound_port_does_not_break_match() {
        let routers = HashMap::from([(
            "patient-browser".to_owned(),
            internal_router("patient-browser"),
        )]);
        let router = dispatch_router(routers, Some("demo.example.com"));
        let res = router
            .oneshot(request(&[(
                "x-public-origin",
                "patient-browser.demo.example.com:8443",
            )]))
            .await
            .expect("oneshot");
        assert_eq!(body_string(res).await, "INTERNAL: patient-browser");
    }

    /// Unit tests for `match_internal_subdomain` — exercise edge cases
    /// (IPv6, no dot, empty rest) without standing up routers.
    #[test]
    fn match_internal_subdomain_handles_edge_cases() {
        let known: HashSet<&str> = ["patient-browser", "labs"].into_iter().collect();
        let is_known = |id: &str| known.contains(id);

        assert_eq!(
            match_internal_subdomain("patient-browser.demo.example.com", "demo.example.com", is_known),
            Some("patient-browser".to_owned()),
        );
        // No dot at all — no subdomain.
        assert_eq!(match_internal_subdomain("apex", "demo.example.com", is_known), None);
        // Leftmost label not in the catalogue.
        assert_eq!(
            match_internal_subdomain("admin.demo.example.com", "demo.example.com", is_known),
            None,
        );
        // IPv6 in brackets — no DNS subdomain to extract.
        assert_eq!(
            match_internal_subdomain("[::1]:8080", "demo.example.com", is_known),
            None,
        );
    }
}
