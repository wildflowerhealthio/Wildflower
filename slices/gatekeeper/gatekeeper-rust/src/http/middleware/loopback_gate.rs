use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use std::net::SocketAddr;

pub async fn loopback_gate(
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
        Some(_) => (StatusCode::FORBIDDEN, "non-loopback peer rejected").into_response(),
        // No ConnectInfo means we weren't mounted with
        // `into_make_service_with_connect_info`. Fail closed to avoid
        // accidentally serving non-loopback clients silently.
        // TODO(tunnel): tunnel-trusted peers will bypass this gate.
        None => (StatusCode::FORBIDDEN, "no peer info").into_response(),
    }
}
