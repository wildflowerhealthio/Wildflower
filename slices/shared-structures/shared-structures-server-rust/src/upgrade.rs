//! Transparent connection-upgrade (WebSocket) proxying.
//!
//! reqwest (the streaming [`forward`](crate::reverse_proxy) path) is a
//! request/response client — it can't carry a `101 Switching Protocols` or
//! expose the raw upgraded socket. So a matched-subdomain request that carries
//! an `Upgrade` header is handled here instead: a low-level hyper client
//! connection performs the handshake against the upstream loopback port, and on
//! a `101` both upgraded sockets are spliced with
//! [`tokio::io::copy_bidirectional`]. Protocol-agnostic (any `Upgrade`, not just
//! WebSocket) because it relays bytes rather than re-framing messages.

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use http_body_util::Empty;
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use url::Url;

use crate::params::loopback_authority;
use crate::reverse_proxy::is_hop_by_hop;

/// Proxy an `Upgrade` request (e.g. WebSocket) to the `{host}:{port}` picked out
/// of `loopback_base_url` by splicing the two upgraded connections. Returns the
/// upstream's `101` (which drives the inbound upgrade), or relays the upstream's
/// response if it declines the upgrade. A connect/handshake failure is a `502`.
pub(crate) async fn forward_upgrade(
    loopback_base_url: &Url,
    port: u16,
    mut req: Request,
) -> Response {
    // Take the inbound upgrade future before the request is consumed; it
    // resolves once we return the `101` below and the server performs the upgrade.
    let inbound_upgrade = hyper::upgrade::on(&mut req);

    let addr = loopback_authority(loopback_base_url, port);
    let stream = match TcpStream::connect(&addr).await {
        Ok(stream) => stream,
        Err(error) => {
            tracing::warn!(%error, %addr, "reverse-proxy upgrade connect failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    let (mut sender, conn) = match hyper::client::conn::http1::handshake::<_, Empty<Bytes>>(
        TokioIo::new(stream),
    )
    .await
    {
        Ok(pair) => pair,
        Err(error) => {
            tracing::warn!(%error, %addr, "reverse-proxy upgrade handshake failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    // Drive the upstream client connection — `with_upgrades` so it yields the
    // upgraded socket — on its own task.
    tokio::spawn(async move {
        if let Err(error) = conn.with_upgrades().await {
            tracing::debug!(%error, "reverse-proxy upgrade upstream connection ended");
        }
    });

    let (parts, _body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let uri: Uri = match path_and_query.parse() {
        Ok(uri) => uri,
        Err(error) => {
            tracing::warn!(%error, "reverse-proxy upgrade bad request target");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    // Forward the headers verbatim — the upgrade handshake NEEDS `connection`,
    // `upgrade`, `sec-websocket-*` — only re-pointing `host` at the upstream
    // authority (this is a low-level conn, so `host` isn't set for us).
    let mut upstream_req = hyper::Request::new(Empty::<Bytes>::new());
    *upstream_req.method_mut() = parts.method.clone();
    *upstream_req.uri_mut() = uri;
    *upstream_req.headers_mut() = parts.headers.clone();
    if let Ok(host) = HeaderValue::from_str(&addr) {
        upstream_req.headers_mut().insert(header::HOST, host);
    }

    let mut upstream_resp = match sender.send_request(upstream_req).await {
        Ok(resp) => resp,
        Err(error) => {
            tracing::warn!(%error, %addr, "reverse-proxy upgrade request failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    if upstream_resp.status() != StatusCode::SWITCHING_PROTOCOLS {
        // Upstream declined the upgrade (no WS endpoint there, bad request, …) —
        // relay its normal response so the client sees a clean non-`101`.
        return relay_non_upgrade(upstream_resp);
    }

    // Take the upstream upgrade future, then build the downstream `101` from the
    // upstream's switching-protocols headers.
    let upstream_upgrade = hyper::upgrade::on(&mut upstream_resp);
    let mut downstream = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    if let Some(headers) = downstream.headers_mut() {
        for (name, value) in upstream_resp.headers() {
            headers.append(name, value.clone());
        }
    }
    let downstream = match downstream.body(Body::empty()) {
        Ok(resp) => resp,
        Err(error) => {
            tracing::warn!(%error, "reverse-proxy upgrade response build failed");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };

    // Once both sides have switched protocols, splice them byte-for-byte.
    tokio::spawn(async move {
        let (client, upstream) = tokio::join!(inbound_upgrade, upstream_upgrade);
        let (client, upstream) = match (client, upstream) {
            (Ok(client), Ok(upstream)) => (client, upstream),
            (client, upstream) => {
                tracing::warn!(
                    client_ok = client.is_ok(),
                    upstream_ok = upstream.is_ok(),
                    "reverse-proxy upgrade splice aborted; an upgrade did not complete",
                );
                return;
            }
        };
        let mut client = TokioIo::new(client);
        let mut upstream = TokioIo::new(upstream);
        if let Err(error) = tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
            tracing::debug!(%error, "reverse-proxy upgrade splice ended");
        }
    });

    downstream
}

/// Relay a non-`101` upstream response (the upstream declined the upgrade) as a
/// normal response: status + streamed body + non-hop-by-hop headers.
fn relay_non_upgrade(resp: hyper::Response<hyper::body::Incoming>) -> Response {
    let (parts, body) = resp.into_parts();
    let mut out = Response::new(Body::new(body));
    *out.status_mut() = parts.status;
    let headers = out.headers_mut();
    for (name, value) in &parts.headers {
        if is_hop_by_hop(name) {
            continue;
        }
        headers.append(name, value.clone());
    }
    out
}
