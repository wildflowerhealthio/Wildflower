use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::StatusCode;
use axum::middleware::{FromFnLayer, Next};
use axum::response::IntoResponse;
use axum::Extension;
use std::net::SocketAddr;

type PeerInfo = Option<Extension<ConnectInfo<SocketAddr>>>;

/// Fn-pointer form of the gate handler — nameable so the layer type is too.
type LoopbackGateFn = fn(PeerInfo, Request<Body>, Next) -> super::MiddlewareFuture;

/// The tower `Layer` [`require_loopback_peer_middleware`] returns.
pub type RequireLoopbackPeerMiddleware = FromFnLayer<LoopbackGateFn, (), (PeerInfo, Request<Body>)>;

/// The loopback-peer gate — `403` for any non-loopback peer or missing
/// `ConnectInfo` (fail closed). Idempotent: stacking on a router that already
/// carries the gate is harmless. See `docs/Origins/Explanation.md`.
pub fn require_loopback_peer_middleware() -> RequireLoopbackPeerMiddleware {
    let handler: LoopbackGateFn = |peer_info, req, next| {
        Box::pin(async move {
            match peer_info.map(|Extension(ConnectInfo(addr))| addr.ip()) {
                Some(ip) if ip.is_loopback() => next.run(req).await,
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
