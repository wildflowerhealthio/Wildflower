//! The tunnel listener's front: the outermost layer of the tunnel router, which
//! writes each tunnel request's `Forwarded` header from its `Host` and the
//! visitor's PROXY address, so the layers and handlers that read `Forwarded`
//! (`shared_structures_rust::served_origin`) see a tunnel request exactly as
//! they see one a trusted front relayed.

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{FORWARDED, HOST};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tunnel_rust::public_origin_url;
use url::Url;

use crate::http::tunnel_listener::TunnelVisitor;

/// Write the `Forwarded` header of a request on the tunnel listener, replacing
/// any it carried: `for=<visitor>;host="<public host>";proto=https`. A request
/// whose host isn't the server's public host is answered `421 Misdirected
/// Request` instead.
///
/// `public_origin` is the server's public origin, `https://<public host>`.
///
/// # Remarks
///
/// Nothing on the path from the visitor vouches for a tunnel request's
/// headers: the relay forwards bytes and the visitor writes the rest, so an
/// inbound `Forwarded` is the visitor's own claim and is discarded. The host is
/// trusted only once it names the public host, compared as `https` origins so
/// case and a spelled-out `:443` don't matter, and a public host with a port
/// needs that port. A request with no host names no origin this server answers
/// as, and is refused the same way. The written `host` is the public origin's,
/// normalized, and `proto` is always `https`.
///
/// `for` is the visitor's address from the PROXY header, without its port, and
/// is left out when the connection had none: the tunnel hands its connections
/// over in process, so no socket peer names the visitor instead. An IPv6
/// address is bracketed and quoted, as RFC 7239 requires, which
/// `served_origin::forwarded_client_address` unquotes.
pub(crate) async fn stamp_tunnel_forwarded(
    State(public_origin): State<Url>,
    ConnectInfo(tunnel_visitor): ConnectInfo<TunnelVisitor>,
    mut request: Request,
    next: Next,
) -> Response {
    let names_public_origin = request_host(&request)
        .and_then(|request_host| public_origin_url(request_host).ok())
        .is_some_and(|request_origin| request_origin.origin() == public_origin.origin());
    if !names_public_origin {
        return (
            StatusCode::MISDIRECTED_REQUEST,
            "request host is not this server's public host",
        )
            .into_response();
    }
    let forwarded = match tunnel_forwarded(tunnel_visitor.client_address, &public_origin) {
        Ok(forwarded) => forwarded,
        Err(error) => {
            tracing::error!("a tunnel request's Forwarded header can't be written: {error}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // `insert` replaces every inbound `Forwarded` value.
    request.headers_mut().insert(FORWARDED, forwarded);
    next.run(request).await
}

/// The host a request addressed: its `Host` header, or for HTTP/2, which
/// carries no `Host`, the request URI's authority.
fn request_host(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(HOST)
        .and_then(|host| host.to_str().ok())
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.as_str())
        })
}

/// The `Forwarded` header for a tunnel request served as `public_origin`, from
/// the visitor at `client_address` when the PROXY header named one.
fn tunnel_forwarded(
    client_address: Option<SocketAddr>,
    public_origin: &Url,
) -> Result<HeaderValue, axum::http::header::InvalidHeaderValue> {
    let host_and_proto = format!("host=\"{}\";proto=https", public_origin.authority());
    let forwarded = match client_address.map(|client_address| client_address.ip()) {
        Some(IpAddr::V4(client_ip)) => format!("for={client_ip};{host_and_proto}"),
        Some(IpAddr::V6(client_ip)) => format!("for=\"[{client_ip}]\";{host_and_proto}"),
        None => host_and_proto,
    };
    HeaderValue::from_str(&forwarded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::routing::get;
    use axum::Router;
    use shared_structures_rust::served_origin::{
        forwarded_client_address, request_provenance, RequestProvenance,
    };
    use tower::ServiceExt;

    /// The public host most cases are served at.
    const PUBLIC_HOST: &str = "dev1.example.com";

    /// A router behind the layer, for the server at `public_host`, whose
    /// handler answers with the `Forwarded` header it was handed, or `-` for
    /// none.
    fn stamping_router(public_host: &str) -> Router {
        Router::new()
            .route(
                "/",
                get(|request: Request| async move {
                    request
                        .headers()
                        .get(FORWARDED)
                        .map_or_else(|| "-".to_owned(), |f| f.to_str().unwrap().to_owned())
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                public_origin_url(public_host).expect("public origin"),
                stamp_tunnel_forwarded,
            ))
    }

    /// A tunnel request from the visitor at `client_address`, with `headers`.
    fn tunnel_request(client_address: Option<&str>, headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::get("/");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let mut request = builder.body(Body::empty()).expect("request");
        request.extensions_mut().insert(ConnectInfo(TunnelVisitor {
            client_address: client_address.map(|address| address.parse().expect("address")),
        }));
        request
    }

    /// The status and the `Forwarded` header the handler saw (`-` for none).
    async fn send(public_host: &str, request: Request) -> (StatusCode, String) {
        let response = stamping_router(public_host)
            .oneshot(request)
            .await
            .expect("oneshot");
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, String::from_utf8(body.to_vec()).expect("utf-8"))
    }

    /// `forwarded` as the single `Forwarded` header of a request.
    fn forwarded_headers(forwarded: &str) -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(FORWARDED, HeaderValue::from_str(forwarded).unwrap());
        headers
    }

    #[tokio::test]
    async fn a_tunnel_request_is_stamped_as_the_public_origin() {
        let (status, seen) = send(
            PUBLIC_HOST,
            tunnel_request(Some("192.0.2.1:4711"), &[("host", PUBLIC_HOST)]),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(seen, "for=192.0.2.1;host=\"dev1.example.com\";proto=https");

        // The stamp reads back through the shared parser as the public origin.
        let headers = forwarded_headers(&seen);
        assert_eq!(
            request_provenance(&headers),
            Some(RequestProvenance::Forwarded {
                base_url: Url::parse("https://dev1.example.com").unwrap(),
            })
        );
        assert_eq!(forwarded_client_address(&headers), Some("192.0.2.1"));
    }

    #[tokio::test]
    async fn an_ipv6_visitor_is_bracketed_and_quoted() {
        let (_, seen) = send(
            PUBLIC_HOST,
            tunnel_request(Some("[2001:db8::1]:4711"), &[("host", PUBLIC_HOST)]),
        )
        .await;
        assert_eq!(
            seen,
            "for=\"[2001:db8::1]\";host=\"dev1.example.com\";proto=https"
        );
        assert_eq!(
            forwarded_client_address(&forwarded_headers(&seen)),
            Some("[2001:db8::1]")
        );
    }

    /// Without a PROXY address there is no `for`.
    #[tokio::test]
    async fn a_tunnel_request_without_a_proxy_address_has_no_for() {
        let (_, seen) = send(PUBLIC_HOST, tunnel_request(None, &[("host", PUBLIC_HOST)])).await;
        assert_eq!(seen, "host=\"dev1.example.com\";proto=https");
        assert_eq!(forwarded_client_address(&forwarded_headers(&seen)), None);
    }

    /// A visitor's own `Forwarded` headers (here claiming another host and
    /// other clients) are replaced, not appended to.
    #[tokio::test]
    async fn a_visitor_s_forwarded_headers_are_replaced() {
        let (status, seen) = send(
            PUBLIC_HOST,
            tunnel_request(
                None,
                &[
                    ("host", PUBLIC_HOST),
                    (
                        "forwarded",
                        "for=203.0.113.9;host=evil.example.com;proto=http",
                    ),
                    ("forwarded", "for=203.0.113.10"),
                ],
            ),
        )
        .await;
        assert_eq!(
            (status, seen.as_str()),
            (StatusCode::OK, "host=\"dev1.example.com\";proto=https")
        );
    }

    /// Hosts are compared as `https` origins: case and the default port are
    /// spelling, a port on the public host is part of it. The stamped host is
    /// the public origin's, normalized.
    #[tokio::test]
    async fn the_host_matches_the_public_host_as_an_origin() {
        for (public_host, request_host, stamped_host) in [
            ("dev1.example.com", "DEV1.Example.COM", "dev1.example.com"),
            (
                "dev1.example.com",
                "dev1.example.com:443",
                "dev1.example.com",
            ),
            ("Dev1.Example.com", "dev1.example.com", "dev1.example.com"),
            (
                "dev1.example.com:8443",
                "dev1.example.com:8443",
                "dev1.example.com:8443",
            ),
        ] {
            let (status, seen) =
                send(public_host, tunnel_request(None, &[("host", request_host)])).await;
            assert_eq!(status, StatusCode::OK, "{public_host} / {request_host}");
            assert_eq!(
                seen,
                format!("host=\"{stamped_host}\";proto=https"),
                "{public_host} / {request_host}"
            );
        }
    }

    #[tokio::test]
    async fn a_host_that_isn_t_the_public_host_is_misdirected() {
        for (public_host, request_host) in [
            ("dev1.example.com", Some("dev2.example.com")),
            ("dev1.example.com", Some("dev1.example.com:8443")),
            ("dev1.example.com:8443", Some("dev1.example.com")),
            ("dev1.example.com", Some("127.0.0.1:8080")),
            ("dev1.example.com", Some("user@dev1.example.com")),
            ("dev1.example.com", None),
        ] {
            let headers: Vec<(&str, &str)> = request_host
                .map(|host| ("host", host))
                .into_iter()
                .collect();
            let (status, seen) = send(public_host, tunnel_request(None, &headers)).await;
            assert_eq!(
                status,
                StatusCode::MISDIRECTED_REQUEST,
                "{public_host} / {request_host:?}"
            );
            assert_ne!(seen, "-", "the handler never ran");
        }
    }
}
