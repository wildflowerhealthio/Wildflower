//! The limit on starting authorization requests, on the tunnel listener's
//! router: how fast visitors may call the two routes that start one,
//! `GET /oauth/authorize` and `POST /oauth/device_authorization`.
//!
//! Anyone who knows the server's domain can start a request, and each one
//! parks a request and raises the Owner's approval popup on the server's
//! device. Both routes cost the Owner that same popup, so every call to
//! either spends from one [`AuthorizationStartLimiter`]: the visitor's own
//! allowance and one shared by every visitor. A call either allowance refuses
//! spends from neither, and is answered `429 Too Many Requests` before the
//! request is parsed, so every attempt counts, however malformed. Every other
//! route passes through untouched.
//!
//! Each allowance is a [`Rate`]: a burst of attempts at once, refilled one
//! attempt per interval, [`PER_CLIENT`] for each visitor and [`GLOBAL`]
//! across all of them.
//!
//! A visitor is keyed by the address its [`TunnelVisitor`] connect info
//! holds, as a [`ClientKey`]: its IPv4 address, or its IPv6 address's `/64`.
//! The TCP peer of every tunnel connection is the in-process tunnel, so that
//! address comes from the PROXY header the relay writes ahead of each
//! connection (see `tunnel_listener::proxy_header`), which the visitor can't
//! write. A connection with no address shares one allowance with every other
//! such connection. A `Forwarded` or `X-Forwarded-*` header is the visitor's
//! own claim and is never read; the tunnel front drops them before this
//! layer anyway (see `refuse_misdirected_requests`). At most [`MAX_CLIENTS`]
//! visitors are tracked; once the table is full, visitors whose allowance has
//! refilled are dropped, and if none has, new visitors are refused until one
//! does. The limiter itself is `wildflowerhealthio_kitchen_sink`'s
//! [`RateLimiter`].

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use wildflowerhealthio_authorization_server::{AUTHORIZE_PATH, DEVICE_AUTHORIZATION_PATH};
use wildflowerhealthio_kitchen_sink::rate_limit::{ClientKey, Rate, RateLimiter};

use crate::http::tunnel_listener::TunnelVisitor;

/// The limits on starting an authorization request, by visitor: `None` for
/// every visitor whose connection named no address.
pub(crate) type AuthorizationStartLimiter = RateLimiter<Option<ClientKey>>;

/// Each visitor's allowance: ten requests at once, then one every thirty
/// seconds (120 an hour). Enough for a person opening several apps at once,
/// or a developer reloading one, while one address can't flood the Owner with
/// popups.
pub(crate) const PER_CLIENT: Rate = Rate {
    burst: 10,
    interval: Duration::from_secs(30),
};

/// The allowance every visitor shares: thirty requests at once, then one
/// every ten seconds (360 an hour). The server has one Owner, so this caps
/// how fast popups reach them, however many addresses ask.
pub(crate) const GLOBAL: Rate = Rate {
    burst: 30,
    interval: Duration::from_secs(10),
};

/// The most visitors tracked at once.
pub(crate) const MAX_CLIENTS: usize = 1_024;

/// What a request over the limits is answered.
const RATE_LIMITED: &str = "too many authorization requests; try again later";

/// Answer a request that starts an authorization request `429 Too Many
/// Requests` when `limiter` refuses its visitor, and pass every other request
/// on.
pub(crate) async fn limit_authorization_starts(
    State(limiter): State<Arc<AuthorizationStartLimiter>>,
    ConnectInfo(tunnel_visitor): ConnectInfo<TunnelVisitor>,
    request: Request,
    next: Next,
) -> Response {
    if starts_authorization_request(&request)
        && !limiter.admit(visitor_key(tunnel_visitor), Instant::now())
    {
        tracing::debug!(
            client_address = ?tunnel_visitor.client_address,
            "authorization request refused: rate limited"
        );
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::CACHE_CONTROL, "no-store")],
            RATE_LIMITED,
        )
            .into_response();
    }
    next.run(request).await
}

/// Whether `request` is one that starts an authorization request:
/// `GET` [`AUTHORIZE_PATH`] or `POST` [`DEVICE_AUTHORIZATION_PATH`].
fn starts_authorization_request(request: &Request) -> bool {
    let path = request.uri().path();
    (request.method() == Method::GET && path == AUTHORIZE_PATH)
        || (request.method() == Method::POST && path == DEVICE_AUTHORIZATION_PATH)
}

/// The key `tunnel_visitor`'s allowance is kept under: its address's
/// [`ClientKey`], or `None` when its connection named no address.
fn visitor_key(tunnel_visitor: TunnelVisitor) -> Option<ClientKey> {
    tunnel_visitor
        .client_address
        .map(|client_address| ClientKey::from(client_address.ip()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::{get, post};
    use axum::Router;
    use tower::ServiceExt;

    /// A small per-visitor allowance, so a test spends it in a few requests.
    const TEST_PER_CLIENT: Rate = Rate {
        burst: 2,
        interval: Duration::from_secs(3_600),
    };

    /// A shared allowance larger than one visitor's and smaller than three
    /// visitors'.
    const TEST_GLOBAL: Rate = Rate {
        burst: 5,
        interval: Duration::from_secs(3_600),
    };

    const ALICE: Option<&str> = Some("192.0.2.1:4711");
    const BOB: Option<&str> = Some("198.51.100.9:4711");
    const CAROL: Option<&str> = Some("[2001:db8::1]:4711");

    /// A router whose routes answer `200`, the ones the limit acts on and
    /// some beside them, behind the layer with the test rates.
    fn limited_router() -> Router {
        let limiter = Arc::new(AuthorizationStartLimiter::new(
            TEST_PER_CLIENT,
            TEST_GLOBAL,
            MAX_CLIENTS,
        ));
        Router::new()
            .route(AUTHORIZE_PATH, get(|| async { "authorize" }))
            .route(
                DEVICE_AUTHORIZATION_PATH,
                post(|| async { "device_authorization" }),
            )
            .route("/oauth/token", post(|| async { "token" }))
            .route("/oauth/authorize/{id}", get(|| async { "status" }))
            .route("/oauth/authorize/{id}/wait", get(|| async { "wait" }))
            .layer(axum::middleware::from_fn_with_state(
                limiter,
                limit_authorization_starts,
            ))
    }

    /// A tunnel request `method path` from the visitor at `client_address`.
    fn tunnel_request(method: Method, path: &str, client_address: Option<&str>) -> Request {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .expect("request");
        request.extensions_mut().insert(ConnectInfo(TunnelVisitor {
            client_address: client_address.map(|address| address.parse().expect("address")),
        }));
        request
    }

    /// The status `router` answers `method path` from `client_address` with.
    async fn status(
        router: &Router,
        method: Method,
        path: &str,
        client_address: Option<&str>,
    ) -> StatusCode {
        router
            .clone()
            .oneshot(tunnel_request(method, path, client_address))
            .await
            .expect("oneshot")
            .status()
    }

    /// `GET /oauth/authorize` from `client_address`.
    async fn authorize(router: &Router, client_address: Option<&str>) -> StatusCode {
        status(router, Method::GET, AUTHORIZE_PATH, client_address).await
    }

    #[tokio::test]
    async fn a_visitor_over_its_burst_is_refused_and_another_still_gets_through() {
        let router = limited_router();
        for _ in 0..TEST_PER_CLIENT.burst {
            assert_eq!(authorize(&router, ALICE).await, StatusCode::OK);
        }

        let refused = router
            .clone()
            .oneshot(tunnel_request(Method::GET, AUTHORIZE_PATH, ALICE))
            .await
            .expect("oneshot");
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            refused.headers().get(header::CACHE_CONTROL),
            Some(&header::HeaderValue::from_static("no-store"))
        );
        let body = axum::body::to_bytes(refused.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(body, RATE_LIMITED.as_bytes());

        assert_eq!(authorize(&router, BOB).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn device_authorization_spends_from_the_same_allowance_as_authorize() {
        let router = limited_router();
        assert_eq!(authorize(&router, ALICE).await, StatusCode::OK);
        assert_eq!(
            status(&router, Method::POST, DEVICE_AUTHORIZATION_PATH, ALICE).await,
            StatusCode::OK
        );

        assert_eq!(
            authorize(&router, ALICE).await,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            status(&router, Method::POST, DEVICE_AUTHORIZATION_PATH, ALICE).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn once_the_shared_allowance_is_spent_every_visitor_is_refused() {
        let router = limited_router();
        let mut admitted = 0;
        for client_address in [ALICE, BOB, CAROL] {
            for _ in 0..TEST_PER_CLIENT.burst {
                if authorize(&router, client_address).await == StatusCode::OK {
                    admitted += 1;
                }
            }
        }
        assert_eq!(admitted, TEST_GLOBAL.burst);

        for client_address in [Some("203.0.113.7:4711"), None] {
            assert_eq!(
                authorize(&router, client_address).await,
                StatusCode::TOO_MANY_REQUESTS,
                "{client_address:?}"
            );
        }
    }

    #[tokio::test]
    async fn other_routes_are_never_limited() {
        let router = limited_router();
        for _ in 0..TEST_PER_CLIENT.burst {
            assert_eq!(authorize(&router, ALICE).await, StatusCode::OK);
        }
        assert_eq!(
            authorize(&router, ALICE).await,
            StatusCode::TOO_MANY_REQUESTS
        );

        for _ in 0..TEST_GLOBAL.burst * 2 {
            for (method, path) in [
                (Method::POST, "/oauth/token"),
                (Method::GET, "/oauth/authorize/request-id"),
                (Method::GET, "/oauth/authorize/request-id/wait"),
            ] {
                assert_eq!(
                    status(&router, method, path, ALICE).await,
                    StatusCode::OK,
                    "{path}"
                );
            }
        }
    }

    #[tokio::test]
    async fn visitors_with_no_address_share_one_allowance() {
        let router = limited_router();
        for _ in 0..TEST_PER_CLIENT.burst {
            assert_eq!(authorize(&router, None).await, StatusCode::OK);
        }

        assert_eq!(
            authorize(&router, None).await,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(authorize(&router, ALICE).await, StatusCode::OK);
    }
}
