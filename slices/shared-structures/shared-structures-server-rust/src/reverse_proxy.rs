//! [`TunnelSubdomainReverseProxy`] — wrap a fallback router and reverse-proxy
//! inbound forwarded `<id>.<public_host>` requests to the matching host's
//! loopback port.
//!
//! The forward is a real HTTP hop to `http://{loopback}:{port}` — the same
//! listener a local launch reaches — so the proxy holds only an `id -> port`
//! table ([`ProxyTable`]), never the per-host services. That table is shared
//! with the orchestrator that starts the hosts, so registering a host at runtime
//! is visible to the next forwarded request with no restart.
//!
//! Connection upgrades (WebSocket) are proxied too: a matched-subdomain request
//! carrying an `Upgrade` header is handed to [`crate::upgrade`] — a connection
//! splice — instead of the buffer-free streaming [`forward`] below (reqwest
//! can't carry a `101` / raw upgrade).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};
use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService};
use tokio::sync::watch;

use crate::error::ServerError;
use crate::host_match::match_forwarded_origin;
use crate::params::LoopbackHostname;

/// Hop-by-hop headers (RFC 7230 §6.1) — meaningful only for a single transport
/// hop, never forwarded. `host` is dropped separately (the HTTP client sets it
/// to the upstream authority). Shared with [`crate::upgrade`] for relaying a
/// declined-upgrade response.
pub(crate) fn is_hop_by_hop(name: &HeaderName) -> bool {
    const HOP_BY_HOP: [&str; 8] = [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ];
    HOP_BY_HOP.contains(&name.as_str())
}

/// The mutable `id -> loopback port` routing table, shared (cloned `Arc`)
/// between the register/unregister handle the orchestrator holds and the live
/// forwarding middleware. `RwLock` because the middleware reads it on every
/// forwarded request while register/unregister are rare.
#[derive(Clone, Default)]
pub struct ProxyTable {
    inner: Arc<RwLock<HashMap<String, u16>>>,
}

impl ProxyTable {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or overwrite) the loopback port a forwarded `<id>.<host>`
    /// request is reverse-proxied to.
    ///
    /// # Errors
    ///
    /// [`ServerError::LockPoisoned`] if a prior holder of the table lock panicked.
    pub fn register(&self, id: impl Into<String>, port: u16) -> Result<(), ServerError> {
        self.inner
            .write()
            .map_err(|_| ServerError::lock("proxy table"))?
            .insert(id.into(), port);
        Ok(())
    }

    /// Remove an id from the table. Returns `true` if it was registered.
    ///
    /// # Errors
    ///
    /// [`ServerError::LockPoisoned`] if a prior holder of the table lock panicked.
    pub fn unregister(&self, id: &str) -> Result<bool, ServerError> {
        Ok(self
            .inner
            .write()
            .map_err(|_| ServerError::lock("proxy table"))?
            .remove(id)
            .is_some())
    }

    fn port_for(&self, id: &str) -> Result<Option<u16>, ServerError> {
        Ok(self
            .inner
            .read()
            .map_err(|_| ServerError::lock("proxy table"))?
            .get(id)
            .copied())
    }
}

struct ReverseProxyState {
    table: ProxyTable,
    /// The live public host, read `O(1)` off the tunnel's liveness watch on
    /// every forwarded request. Subscribing once (rather than calling
    /// [`TunnelService::current_public_host`] per request) keeps the hot path
    /// off the tunnel slice's locked settings read. The public host only
    /// changes on a settings write, which republishes the watch.
    public_host_rx: watch::Receiver<TunnelLiveness>,
    loopback: LoopbackHostname,
    client: reqwest::Client,
}

impl ReverseProxyState {
    /// The current configured public host (bare, no scheme/port), or `None` when
    /// unconfigured — read straight off the liveness watch.
    fn current_public_host(&self) -> Option<String> {
        self.public_host_rx.borrow().public_host.clone()
    }
}

/// Wraps a fallback router; reverse-proxies forwarded `<id>.<public_host>`
/// requests to the matching host's loopback port, everything else to the
/// fallback.
pub struct TunnelSubdomainReverseProxy {
    state: Arc<ReverseProxyState>,
    fallback: Router,
}

impl TunnelSubdomainReverseProxy {
    /// Construct with the fallback router up front. Shares `table` with the
    /// caller (the orchestrator registers hosts on the same handle), subscribes
    /// to `tunnel`'s liveness watch for the live public host (read `O(1)` per
    /// request, no per-request settings query), and forwards to
    /// `{loopback}:{port}`.
    #[must_use]
    pub fn new(
        loopback: LoopbackHostname,
        tunnel: Arc<dyn TunnelService>,
        fallback: Router,
        table: ProxyTable,
    ) -> Self {
        Self {
            state: Arc::new(ReverseProxyState {
                table,
                public_host_rx: tunnel.subscribe(),
                loopback,
                client: proxy_client(),
            }),
            fallback,
        }
    }

    /// The router to serve: the fallback wrapped with the forwarding middleware
    /// as the outermost layer (it runs before the fallback).
    pub fn into_router(self) -> Router {
        self.fallback.layer(axum::middleware::from_fn_with_state(
            self.state,
            maybe_forward_to_subdomain,
        ))
    }
}

async fn maybe_forward_to_subdomain(
    State(state): State<Arc<ReverseProxyState>>,
    req: Request,
    next: Next,
) -> Response {
    let RequestProvenance::Forwarded { origin } = request_provenance(req.headers()) else {
        return next.run(req).await;
    };
    let Some(public_host) = state.current_public_host() else {
        // Public host unconfigured: no inbound subdomain can match.
        return next.run(req).await;
    };
    let Some(app_id) = match_forwarded_origin(&origin, &public_host) else {
        return next.run(req).await;
    };
    let port = match state.table.port_for(&app_id) {
        // Matched the `<id>.<public_host>` shape and a host is registered.
        Ok(Some(port)) => port,
        // Matched the shape but no host is registered for that id — fall through
        // to the fallback rather than erroring here.
        Ok(None) => return next.run(req).await,
        // A poisoned table must not fail the whole request path: log and fall
        // through to the fallback.
        Err(error) => {
            tracing::error!(%error, "proxy table read failed; falling through to fallback");
            return next.run(req).await;
        }
    };
    // Connection upgrades (WebSocket) can't go through the reqwest streaming
    // path — splice the two connections instead.
    if req.headers().contains_key(axum::http::header::UPGRADE) {
        return crate::upgrade::forward_upgrade(&state.loopback, port, req).await;
    }
    forward(&state, port, req).await
}

/// How long to wait for a loopback upstream to accept the TCP connection
/// before giving up with a `502`. Loopback dials either connect ~instantly or
/// fail fast, so this only bounds a pathological half-open socket.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long to wait between body chunks from a stalled upstream before failing
/// the forward. An *inactivity* (read) timeout, deliberately **not** an overall
/// request timeout: this proxy streams arbitrarily large bodies (multi-GiB
/// up/downloads), so a total deadline would abort legitimate slow transfers.
/// A live transfer keeps resetting it; only a truly hung upstream trips it.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The HTTP client the reverse proxy forwards with. Configured for proxy
/// semantics rather than reqwest's user-agent defaults:
///
/// * `redirect(Policy::none())` — a reverse proxy must **relay** an upstream
///   `3xx` (status + `Location`) to the client, not chase it internally;
///   reqwest's default follows up to 10 redirects (and would chase a
///   `Location: http://127.0.0.1:…` *inside* the host).
/// * `connect_timeout` + `read_timeout` — a loopback upstream that accepts the
///   connection but never responds would otherwise hang the forwarded request
///   (and tie up the worker) forever; instead it fails as a `502`.
fn proxy_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        // The builder only fails if the TLS backend / resolver can't initialize;
        // a loopback HTTP proxy has neither, so this is infallible in practice.
        .expect("reverse-proxy HTTP client builds")
}

/// Reverse-proxy `req` to `http://{loopback}:{port}` and return the upstream's
/// response. Request and response bodies are **streamed** — neither is buffered,
/// so a GB-scale upload or download stays O(chunk) in memory with backpressure.
/// A connect/transport failure is a `502`.
async fn forward(state: &ReverseProxyState, port: u16, req: Request) -> Response {
    let (parts, body) = req.into_parts();

    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let url = format!(
        "http://{}{}",
        state.loopback.authority(port),
        path_and_query
    );

    let upstream = state
        .client
        .request(parts.method.clone(), url.as_str())
        .headers(forwardable_headers(&parts.headers))
        // Stream the inbound body straight through rather than buffering it.
        // reqwest frames the unknown-length stream chunked — the inbound
        // `content-length` is dropped in `forwardable_headers` so it can't conflict.
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));

    let resp = match upstream.send().await {
        Ok(resp) => resp,
        Err(error) => {
            tracing::warn!(%error, %url, "reverse-proxy forward to loopback failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    build_response(resp)
}

/// Copy request headers minus the hop-by-hop set, `host` (the client sets it to
/// the upstream authority), and `content-length` (the streamed body is re-framed
/// chunked, so a stale length would conflict).
fn forwardable_headers(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        let name_str = name.as_str();
        if name_str == "host" || name_str == "content-length" || is_hop_by_hop(name) {
            continue;
        }
        out.append(name, value.clone());
    }
    out
}

/// Rebuild the upstream response as an axum [`Response`], **streaming** its body
/// (not buffering) and copying status + all non-hop-by-hop headers. The response
/// `content-length` is among those copied — preserved so a download shows
/// progress, and accurate because the bytes are relayed verbatim.
fn build_response(resp: reqwest::Response) -> Response {
    let status = resp.status();
    let headers = resp.headers().clone();
    let mut response = Response::new(Body::from_stream(resp.bytes_stream()));
    *response.status_mut() = status;
    let out_headers = response.headers_mut();
    for (name, value) in &headers {
        if is_hop_by_hop(name) {
            continue;
        }
        out_headers.append(name, value.clone());
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Instant;

    use axum::body::{to_bytes, Bytes};
    use axum::http::{HeaderValue, Method};
    use axum::routing::{any, get};
    use futures_util::StreamExt;
    use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelStatus};
    use tokio::net::TcpListener;
    use tokio::sync::{watch, Notify};
    use tokio::time::{timeout, Duration};
    use tower::util::ServiceExt;

    /// `TunnelService` stub that publishes a fixed `public_host` on its liveness
    /// watch — the channel the proxy reads (mirrors `TunnelControl`: a configured
    /// setting independent of the daemon's liveness).
    struct StubTunnel {
        public_host: Option<String>,
    }

    #[async_trait::async_trait]
    impl TunnelService for StubTunnel {
        fn current_origin(&self) -> String {
            "http://127.0.0.1:8080".to_owned()
        }
        async fn try_start(&self) -> Result<String, String> {
            Err("not used".to_owned())
        }
        fn subscribe(&self) -> watch::Receiver<TunnelLiveness> {
            watch::channel(TunnelLiveness {
                settings_revision: None,
                status: TunnelStatus::Off,
                origin: self.current_origin(),
                public_host: self.public_host.clone(),
                error: None,
                dial_attempts: 0,
            })
            .1
        }
    }

    /// An upstream that reflects the request it received: method, path, the
    /// `host`/`x-test` headers it saw, and the body — plus an `x-from-upstream`
    /// marker so the proxied path is distinguishable from the fallback.
    async fn spawn_echo_upstream() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().fallback(any(echo));
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    async fn echo(req: Request) -> Response {
        let method = req.method().clone();
        let path = req.uri().path().to_owned();
        let header = |req: &Request, name: &str| {
            req.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("none")
                .to_owned()
        };
        let host = header(&req, "host");
        let xtest = header(&req, "x-test");
        let body = to_bytes(req.into_body(), 1 << 20).await.unwrap();
        let body = String::from_utf8_lossy(&body).into_owned();
        (
            [("x-from-upstream", "yes")],
            format!("method={method} path={path} host={host} xtest={xtest} body={body}"),
        )
            .into_response()
    }

    fn fallback_router() -> Router {
        Router::new().fallback(get(|| async { "FALLBACK" }))
    }

    fn proxy_router(table: ProxyTable, public_host: Option<&str>) -> Router {
        let tunnel: Arc<dyn TunnelService> = Arc::new(StubTunnel {
            public_host: public_host.map(str::to_owned),
        });
        TunnelSubdomainReverseProxy::new(
            LoopbackHostname::new("127.0.0.1"),
            tunnel,
            fallback_router(),
            table,
        )
        .into_router()
    }

    fn request(method: Method, uri: &str, headers: &[(&'static str, &str)], body: &str) -> Request {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::from(body.to_owned()))
            .unwrap();
        for (name, value) in headers {
            req.headers_mut().insert(
                HeaderName::from_static(name),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        req
    }

    async fn body_string(res: Response) -> String {
        String::from_utf8(
            to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }

    /// A forwarded `<id>.<public_host>` request is reverse-proxied to the
    /// registered loopback port: the upstream answers (marker header present),
    /// the `host` header is rewritten to the loopback authority, a normal header
    /// passes through, and the request path is preserved.
    #[tokio::test]
    async fn forwarded_subdomain_is_reverse_proxied_to_the_port() {
        let port = spawn_echo_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let res = router
            .oneshot(request(
                Method::GET,
                "/charts/42",
                &[
                    (
                        "forwarded",
                        "host=patient-browser.demo.example.com;proto=https",
                    ),
                    ("host", "patient-browser.demo.example.com"),
                    ("x-test", "hello"),
                ],
                "",
            ))
            .await
            .expect("oneshot");

        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()
                .get("x-from-upstream")
                .map(|v| v.to_str().unwrap()),
            Some("yes"),
            "response came from the upstream, not the fallback",
        );
        let body = body_string(res).await;
        assert!(body.contains("method=GET"), "{body}");
        assert!(body.contains("path=/charts/42"), "path preserved: {body}");
        assert!(
            body.contains(&format!("host=127.0.0.1:{port}")),
            "host rewritten to loopback authority: {body}",
        );
        assert!(
            body.contains("xtest=hello"),
            "normal header forwarded: {body}"
        );
    }

    /// A POST body round-trips through the proxy to the upstream.
    #[tokio::test]
    async fn post_body_round_trips() {
        let port = spawn_echo_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let res = router
            .oneshot(request(
                Method::POST,
                "/submit",
                &[(
                    "forwarded",
                    "host=patient-browser.demo.example.com;proto=https",
                )],
                "payload-123",
            ))
            .await
            .expect("oneshot");

        let body = body_string(res).await;
        assert!(body.contains("method=POST"), "{body}");
        assert!(body.contains("body=payload-123"), "{body}");
    }

    /// A `public_host` configured with a port still matches+forwards (the
    /// symmetric-port case for a non-443 relay deploy).
    #[tokio::test]
    async fn configured_port_does_not_break_forwarding() {
        let port = spawn_echo_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com:8443"));

        let res = router
            .oneshot(request(
                Method::GET,
                "/",
                &[(
                    "forwarded",
                    "host=patient-browser.demo.example.com:8443;proto=https",
                )],
                "",
            ))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
        assert!(body_string(res).await.contains("method=GET"));
    }

    /// Forwarded apex host, unregistered id, unforwarded request, and missing
    /// public host all fall through to the fallback. (The unregistered case
    /// proves the proxy table — not the host-shape matcher — is the authority.)
    #[tokio::test]
    async fn non_matching_requests_fall_through_to_the_fallback() {
        let port = spawn_echo_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();

        // Apex host (no subdomain).
        let router = proxy_router(table.clone(), Some("demo.example.com"));
        let res = router
            .oneshot(request(
                Method::GET,
                "/",
                &[("forwarded", "host=demo.example.com;proto=https")],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(body_string(res).await, "FALLBACK");

        // Valid shape but unregistered id.
        let router = proxy_router(table.clone(), Some("demo.example.com"));
        let res = router
            .oneshot(request(
                Method::GET,
                "/",
                &[("forwarded", "host=other-app.demo.example.com;proto=https")],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(body_string(res).await, "FALLBACK");

        // Not forwarded at all.
        let router = proxy_router(table.clone(), Some("demo.example.com"));
        let res = router
            .oneshot(request(Method::GET, "/", &[], ""))
            .await
            .unwrap();
        assert_eq!(body_string(res).await, "FALLBACK");

        // No public host configured.
        let router = proxy_router(table, None);
        let res = router
            .oneshot(request(
                Method::GET,
                "/",
                &[(
                    "forwarded",
                    "host=patient-browser.demo.example.com;proto=https",
                )],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(body_string(res).await, "FALLBACK");
    }

    /// A host whose non-subdomain part isn't the configured public host
    /// (`patient-browser.attacker.com`) falls through — never forwarded.
    #[tokio::test]
    async fn wrong_public_host_is_not_forwarded() {
        let port = spawn_echo_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let res = router
            .oneshot(request(
                Method::GET,
                "/",
                &[("forwarded", "host=patient-browser.attacker.com;proto=https")],
                "",
            ))
            .await
            .unwrap();
        assert_eq!(body_string(res).await, "FALLBACK");
    }

    /// A registered id whose loopback port has nothing listening yields `502`
    /// (not a panic, not the fallback).
    #[tokio::test]
    async fn unreachable_upstream_returns_502() {
        // Claim a port then release it, so the connect is refused.
        let dead_port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let table = ProxyTable::new();
        table.register("patient-browser", dead_port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let res = router
            .oneshot(request(
                Method::GET,
                "/",
                &[(
                    "forwarded",
                    "host=patient-browser.demo.example.com;proto=https",
                )],
                "",
            ))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    }

    /// An upstream that always answers `302` with a `Location`, to prove the
    /// proxy *relays* an upstream redirect rather than following it internally.
    /// reqwest's default policy would chase up to 10 hops (and could follow a
    /// `Location: http://127.0.0.1:…` *inside* the host); `proxy_client` disables
    /// it so a reverse proxy hands the `302` straight back to the client.
    async fn spawn_redirecting_upstream() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().fallback(any(|| async {
            (
                StatusCode::FOUND,
                [(
                    axum::http::header::LOCATION,
                    "https://elsewhere.example.com/landing",
                )],
            )
                .into_response()
        }));
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    /// A forwarded request whose upstream answers `302` gets the `302` (and its
    /// `Location`) relayed verbatim — the proxy does not chase the redirect.
    #[tokio::test]
    async fn upstream_redirect_is_relayed_not_followed() {
        let port = spawn_redirecting_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let res = router
            .oneshot(request(
                Method::GET,
                "/",
                &[(
                    "forwarded",
                    "host=patient-browser.demo.example.com;proto=https",
                )],
                "",
            ))
            .await
            .expect("oneshot");

        assert_eq!(
            res.status(),
            StatusCode::FOUND,
            "the upstream 302 is relayed, not followed",
        );
        assert_eq!(
            res.headers()
                .get(axum::http::header::LOCATION)
                .and_then(|v| v.to_str().ok()),
            Some("https://elsewhere.example.com/landing"),
            "the upstream Location is passed through verbatim",
        );
    }

    /// Runtime hot-swap: registering makes a forwarded request reach the
    /// upstream; unregistering makes the same request fall through; registering
    /// again restores it — all on a live, shared table with no restart.
    #[tokio::test]
    async fn register_unregister_swaps_routing_at_runtime() {
        let port = spawn_echo_upstream().await;
        let table = ProxyTable::new();
        let req = || {
            request(
                Method::GET,
                "/",
                &[(
                    "forwarded",
                    "host=patient-browser.demo.example.com;proto=https",
                )],
                "",
            )
        };

        table.register("patient-browser", port).unwrap();
        let res = proxy_router(table.clone(), Some("demo.example.com"))
            .oneshot(req())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        assert!(table.unregister("patient-browser").unwrap());
        let res = proxy_router(table.clone(), Some("demo.example.com"))
            .oneshot(req())
            .await
            .unwrap();
        assert_eq!(body_string(res).await, "FALLBACK");

        table.register("patient-browser", port).unwrap();
        let res = proxy_router(table, Some("demo.example.com"))
            .oneshot(req())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    /// `forwardable_headers` drops `host` and the hop-by-hop set, keeps the rest.
    #[test]
    fn forwardable_headers_strips_host_and_hop_by_hop() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("host"),
            HeaderValue::from_static("a.example.com"),
        );
        headers.insert(
            HeaderName::from_static("connection"),
            HeaderValue::from_static("keep-alive"),
        );
        headers.insert(
            HeaderName::from_static("te"),
            HeaderValue::from_static("trailers"),
        );
        headers.insert(
            HeaderName::from_static("x-keep"),
            HeaderValue::from_static("yes"),
        );

        let out = forwardable_headers(&headers);
        assert!(out.get("host").is_none());
        assert!(out.get("connection").is_none());
        assert!(out.get("te").is_none());
        assert_eq!(out.get("x-keep").map(|v| v.to_str().unwrap()), Some("yes"));
    }

    // ---- streaming / performance ----

    /// Upstream whose handler fires `notify` the moment its first request-body
    /// chunk arrives, then drains the rest. Used to prove the proxy forwards
    /// bytes incrementally rather than buffering the whole body first.
    async fn spawn_first_chunk_notifying_upstream(notify: Arc<Notify>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().fallback(any(move |req: Request| {
            let notify = notify.clone();
            async move {
                let mut body = req.into_body().into_data_stream();
                if body.next().await.is_some() {
                    notify.notify_one();
                }
                while let Some(chunk) = body.next().await {
                    let _ = chunk; // drain without storing
                }
                StatusCode::OK
            }
        }));
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    /// Upstream that counts every request-body byte without storing it and
    /// returns the total as its (text) body.
    async fn spawn_byte_counting_upstream() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().fallback(any(|req: Request| async move {
            let mut body = req.into_body().into_data_stream();
            let mut total: usize = 0;
            while let Some(chunk) = body.next().await {
                total += chunk.expect("request body chunk").len();
            }
            total.to_string()
        }));
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    /// Upstream that produces `chunks` × `chunk_size` zero bytes lazily (never
    /// allocating the whole payload), as a streamed response body.
    async fn spawn_byte_producing_upstream(chunks: usize, chunk_size: usize) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().fallback(any(move |_req: Request| async move {
            let chunk = Bytes::from(vec![0u8; chunk_size]);
            let stream = futures_util::stream::unfold(0usize, move |sent| {
                let chunk = chunk.clone();
                async move { (sent < chunks).then(|| (Ok::<_, std::io::Error>(chunk), sent + 1)) }
            });
            Body::from_stream(stream)
        }));
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    /// The proxy forwards request-body bytes to the upstream *as they arrive*,
    /// not after buffering the whole body: the client body yields chunk 1, then
    /// blocks until the upstream confirms it received chunk 1, then yields chunk
    /// 2. A streaming proxy completes; a buffer-then-forward proxy would
    /// deadlock (upstream never sees chunk 1) — caught by the timeout.
    #[tokio::test]
    async fn request_body_streams_to_the_upstream_incrementally() {
        let notify = Arc::new(Notify::new());
        let port = spawn_first_chunk_notifying_upstream(notify.clone()).await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let body_notify = notify.clone();
        let body = futures_util::stream::unfold(0u8, move |step| {
            let body_notify = body_notify.clone();
            async move {
                match step {
                    0 => Some((Ok::<_, std::io::Error>(Bytes::from_static(b"chunk-1")), 1u8)),
                    1 => {
                        // Won't yield chunk 2 until the upstream has chunk 1 — so
                        // this completes only if the proxy streamed chunk 1 through.
                        body_notify.notified().await;
                        Some((Ok(Bytes::from_static(b"chunk-2")), 2u8))
                    }
                    _ => None,
                }
            }
        });
        let req = Request::builder()
            .method(Method::POST)
            .uri("/")
            .header(
                "forwarded",
                "host=patient-browser.demo.example.com;proto=https",
            )
            .body(Body::from_stream(body))
            .unwrap();

        let res = timeout(Duration::from_secs(5), router.oneshot(req))
            .await
            .expect("streaming proxy should not deadlock — buffering would")
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
    }

    /// Perf: stream 1 GiB *up* through the proxy and confirm the upstream
    /// received every byte. Neither side buffers the payload (lazy 64 KiB
    /// chunks; the upstream counts without storing), so completing this is the
    /// constant-memory proof. Ignored by default (heavy); run with
    /// `cargo test -p shared-structures-server-rust -- --ignored`.
    #[tokio::test]
    #[ignore = "perf: streams 1 GiB upload through the proxy"]
    async fn streams_one_gib_upload_without_buffering() {
        const CHUNK: usize = 64 * 1024;
        const TOTAL: usize = 1024 * 1024 * 1024;
        const CHUNKS: usize = TOTAL / CHUNK;

        let port = spawn_byte_counting_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let chunk = Bytes::from(vec![0u8; CHUNK]);
        let body = futures_util::stream::unfold(0usize, move |sent| {
            let chunk = chunk.clone();
            async move { (sent < CHUNKS).then(|| (Ok::<_, std::io::Error>(chunk), sent + 1)) }
        });
        let req = Request::builder()
            .method(Method::POST)
            .uri("/")
            .header(
                "forwarded",
                "host=patient-browser.demo.example.com;proto=https",
            )
            .body(Body::from_stream(body))
            .unwrap();

        let start = Instant::now();
        let res = router.oneshot(req).await.expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
        let received: usize = body_string(res).await.parse().expect("byte count");
        let elapsed = start.elapsed();
        assert_eq!(received, TOTAL, "upstream received the whole 1 GiB");
        eprintln!(
            "upload: {} MiB in {:.2}s = {:.0} MiB/s",
            TOTAL / 1024 / 1024,
            elapsed.as_secs_f64(),
            (TOTAL as f64 / 1024.0 / 1024.0) / elapsed.as_secs_f64(),
        );
    }

    /// Perf: stream 1 GiB *down* through the proxy and confirm the client
    /// received every byte (drained counting, never stored). Ignored by default;
    /// run with `cargo test -p shared-structures-server-rust -- --ignored`.
    #[tokio::test]
    #[ignore = "perf: streams 1 GiB download through the proxy"]
    async fn streams_one_gib_download_without_buffering() {
        const CHUNK: usize = 64 * 1024;
        const TOTAL: usize = 1024 * 1024 * 1024;
        const CHUNKS: usize = TOTAL / CHUNK;

        let port = spawn_byte_producing_upstream(CHUNKS, CHUNK).await;
        let table = ProxyTable::new();
        table.register("patient-browser", port).unwrap();
        let router = proxy_router(table, Some("demo.example.com"));

        let req = request(
            Method::GET,
            "/",
            &[(
                "forwarded",
                "host=patient-browser.demo.example.com;proto=https",
            )],
            "",
        );
        let start = Instant::now();
        let res = router.oneshot(req).await.expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
        let mut body = res.into_body().into_data_stream();
        let mut received = 0usize;
        while let Some(chunk) = body.next().await {
            received += chunk.expect("response chunk").len();
        }
        let elapsed = start.elapsed();
        assert_eq!(received, TOTAL, "client received the whole 1 GiB");
        eprintln!(
            "download: {} MiB in {:.2}s = {:.0} MiB/s",
            TOTAL / 1024 / 1024,
            elapsed.as_secs_f64(),
            (TOTAL as f64 / 1024.0 / 1024.0) / elapsed.as_secs_f64(),
        );
    }

    // ---- connection upgrades (WebSocket) ----

    /// An upstream that echoes WebSocket text/binary frames back to the sender.
    async fn spawn_ws_echo_upstream() -> u16 {
        use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};

        async fn ws_handler(ws: WebSocketUpgrade) -> Response {
            ws.on_upgrade(|mut socket: WebSocket| async move {
                while let Some(Ok(msg)) = socket.recv().await {
                    let reply = match msg {
                        Message::Text(t) => Message::Text(t),
                        Message::Binary(b) => Message::Binary(b),
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    if socket.send(reply).await.is_err() {
                        break;
                    }
                }
            })
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/ws", get(ws_handler));
        tokio::spawn(async move {
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    /// A forwarded WebSocket to a registered subdomain is proxied end-to-end:
    /// the `101` handshake is relayed and a message round-trips through the
    /// spliced connections. (Drives a real client over a real socket — an
    /// upgrade can't be exercised via `oneshot`.)
    #[tokio::test]
    async fn forwarded_websocket_is_proxied_end_to_end() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message as TMessage;

        let upstream_port = spawn_ws_echo_upstream().await;
        let table = ProxyTable::new();
        table.register("patient-browser", upstream_port).unwrap();
        let proxy = proxy_router(table, Some("demo.example.com"));

        // Serve the proxy on a real port — an upgrade needs a real connection.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, proxy.into_make_service())
                .await
                .unwrap();
        });

        // Open the WebSocket through the proxy, carrying the `Forwarded` header
        // so it routes to the registered subdomain.
        let mut request = format!("ws://127.0.0.1:{proxy_port}/ws")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "forwarded",
            "host=patient-browser.demo.example.com;proto=https"
                .parse()
                .unwrap(),
        );

        let (mut ws, _resp) = tokio_tungstenite::connect_async(request)
            .await
            .expect("websocket handshake through the proxy");
        ws.send(TMessage::Text("hello-through-proxy".into()))
            .await
            .unwrap();
        let echoed = ws.next().await.expect("a reply").expect("ok message");
        assert_eq!(echoed, TMessage::Text("hello-through-proxy".into()));
    }
}
