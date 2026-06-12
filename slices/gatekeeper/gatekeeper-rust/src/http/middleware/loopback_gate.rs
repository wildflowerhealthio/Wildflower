use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::{IpAddr, SocketAddr};

pub async fn loopback_gate(req: Request<Body>, next: Next) -> Response {
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip());
    match peer {
        Some(ip) if is_loopback(ip) => next.run(req).await,
        Some(_) => (StatusCode::FORBIDDEN, "non-loopback peer rejected").into_response(),
        // No ConnectInfo extension means we weren't mounted with
        // `into_make_service_with_connect_info`. Fail closed to avoid
        // accidentally serving non-loopback clients silently.
        // TODO(tunnel): tunnel-trusted peers will bypass this gate.
        None => (StatusCode::FORBIDDEN, "no peer info").into_response(),
    }
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}
