use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::StatusCode;
use axum::middleware::{FromFnLayer, Next};
use axum::response::IntoResponse;
use axum::Extension;
use std::net::SocketAddr;

/// `ConnectInfo` is only populated when the service is mounted with
/// `into_make_service_with_connect_info`, so it's read through the optional
/// `Extension` extractor: `None` means no peer info rather than a rejection,
/// which lets the gate fail closed.
type PeerInfo = Option<Extension<ConnectInfo<SocketAddr>>>;

/// The gate handler as a plain fn pointer — a nameable stand-in for the
/// unutterable fn-item type of the closure [`require_loopback_peer_middleware`]
/// builds. See [`MiddlewareFuture`](super::MiddlewareFuture) for why the future
/// is boxed.
type LoopbackGateFn = fn(PeerInfo, Request<Body>, Next) -> super::MiddlewareFuture;

/// The tower `Layer` [`require_loopback_peer_middleware`] returns, spelled out
/// for the same reason as
/// [`GatekeeperAuthMiddleware`](super::GatekeeperAuthMiddleware). The gate
/// carries no state, so the [`FromFnLayer`] state parameter is `()`.
pub type RequireLoopbackPeerMiddleware = FromFnLayer<LoopbackGateFn, (), (PeerInfo, Request<Body>)>;

/// The loopback-peer gate — pass it to `Router::layer` and any request whose
/// immediate socket peer isn't a loopback address gets a `403` before any
/// handler runs, as does (failing closed) a request with no `ConnectInfo`.
///
/// The "peer" is the other end of *this* connection — a direct local client or
/// the trusted front / reverse proxy / tunnel exit relaying a remote caller (all
/// of which reach us over loopback). It says nothing about who originated the
/// request upstream; forwarded callers are told apart downstream by the
/// `Forwarded` header. See `docs/Origins/Explanation.md`.
///
/// This extends the defense-in-depth the gatekeeper applies to its own
/// [`router`](crate::http::router) to other loopback-only routers, e.g. the
/// host's merged `api_router`; stacking it on a router that already carries the
/// gate is a harmless, idempotent second check.
pub fn require_loopback_peer_middleware() -> RequireLoopbackPeerMiddleware {
    let handler: LoopbackGateFn = |peer_info, req, next| {
        Box::pin(async move {
            match peer_info.map(|Extension(ConnectInfo(addr))| addr.ip()) {
                // `IpAddr::is_loopback` already covers both V4 (127.0.0.0/8) and V6 (::1).
                Some(ip) if ip.is_loopback() => next.run(req).await,
                // A non-loopback peer should be impossible — these servers bind
                // loopback only, and the trusted front relays remote callers from
                // loopback too — so reaching here means a real misconfiguration or
                // probe. Log it (rather than failing silently) so the rejection is
                // diagnosable.
                Some(ip) => {
                    tracing::warn!(peer = %ip, "rejected non-loopback peer at the loopback gate");
                    (StatusCode::FORBIDDEN, "non-loopback peer rejected").into_response()
                }
                // TODO(tunnel): tunnel-trusted peers will bypass this gate.
                None => {
                    tracing::warn!(
                        "rejected request with no peer info at the loopback gate (fail closed)"
                    );
                    (StatusCode::FORBIDDEN, "no peer info").into_response()
                }
            }
        })
    };
    axum::middleware::from_fn(handler)
}
