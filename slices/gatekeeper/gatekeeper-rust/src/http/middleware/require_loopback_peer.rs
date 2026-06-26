use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use std::net::SocketAddr;

/// Reject any request whose immediate socket peer isn't a loopback address.
///
/// The "peer" is the other end of *this* connection — a direct local client or
/// the trusted front / reverse proxy / tunnel exit relaying a remote caller
/// (all of which reach us over loopback). It says nothing about who originated
/// the request upstream; forwarded callers are told apart downstream by the
/// `Forwarded` header.
pub async fn require_loopback_peer(
    // `ConnectInfo` is only populated when the service is mounted with
    // `into_make_service_with_connect_info`, so it's read through the
    // optional `Extension` extractor: `None` means no peer info rather than a
    // rejection, which lets us fail closed below.
    connect_info: Option<Extension<ConnectInfo<SocketAddr>>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    match connect_info.map(|Extension(ConnectInfo(addr))| addr.ip()) {
        // `IpAddr::is_loopback` already covers both V4 (127.0.0.0/8) and V6 (::1).
        Some(ip) if ip.is_loopback() => next.run(req).await,
        // A non-loopback peer should be impossible — these servers bind loopback
        // only, and the trusted front relays remote callers from loopback too —
        // so reaching here means a real misconfiguration or probe. Log it (rather
        // than failing silently) so the rejection is diagnosable.
        Some(ip) => {
            tracing::warn!(peer = %ip, "rejected non-loopback peer at the loopback gate");
            (StatusCode::FORBIDDEN, "non-loopback peer rejected").into_response()
        }
        // No ConnectInfo means we weren't mounted with
        // `into_make_service_with_connect_info`. Fail closed to avoid
        // accidentally serving non-loopback clients silently.
        // TODO(tunnel): tunnel-trusted peers will bypass this gate.
        None => {
            tracing::warn!("rejected request with no peer info at the loopback gate (fail closed)");
            (StatusCode::FORBIDDEN, "no peer info").into_response()
        }
    }
}
