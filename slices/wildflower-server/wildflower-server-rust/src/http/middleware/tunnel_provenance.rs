//! The tunnel listener's stand-in for a trusted front: every request on that
//! listener has its `Forwarded` header written here, from the request's `Host`
//! and the visitor's PROXY address, so the layers and handlers that read
//! `Forwarded` (`shared_structures_rust::served_origin`) see a tunnel request
//! exactly as they would one a front relayed.

use std::net::{IpAddr, SocketAddr};

use axum::extract::{Request, State};
use axum::http::header::{FORWARDED, HOST};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use tokio::sync::watch;
use tunnel_rust::{public_origin_url, TunnelLiveness};
use url::Url;

use crate::http::listener_identity::ListenerIdentity;

/// Stamp the provenance of a request that arrived on the tunnel listener: drop
/// any `Forwarded` header it carried and write
/// `Forwarded: for=<client>;host="<host>";proto=https`, or answer `421
/// Misdirected Request` when its host isn't the tunnel's public host. A request
/// on the local listener passes through untouched.
///
/// `tunnel_liveness` supplies the current public host, so a settings change
/// applies to the next request.
///
/// # Remarks
///
/// Nothing on the path from the visitor vouches for a tunnel request's headers:
/// the relay forwards bytes and the visitor writes the rest, so an inbound
/// `Forwarded` is the visitor's own claim and is discarded. The host is
/// trusted only once it names the configured public host, compared as an
/// `https` origin so case and a spelled-out `:443` don't matter, and a public
/// host with a port needs that port. A request with no host, or arriving while
/// no public host is configured, names no origin this server answers as and
/// is refused the same way. `proto` is always `https`: the public origin is
/// `https://<public host>` (see `tunnel_rust::public_origin_url`).
///
/// `for` is the visitor's address from the PROXY header, and is left out when
/// the connection had none. The rathole client hands the connection over in
/// process, so it has no socket peer to name the visitor instead. An IPv6 address is bracketed and quoted, as RFC 7239
/// requires, which `served_origin::forwarded_client_address` unquotes.
///
/// A request with no [`ListenerIdentity`] never came through `serve`; it is
/// stamped as a tunnel request with no visitor address rather than trusted as
/// local.
pub(crate) async fn stamp_tunnel_provenance(
    State(tunnel_liveness): State<watch::Receiver<TunnelLiveness>>,
    listener_identity: Option<Extension<ListenerIdentity>>,
    mut request: Request,
    next: Next,
) -> Response {
    let client_address = match listener_identity {
        Some(Extension(ListenerIdentity::Local)) => return next.run(request).await,
        Some(Extension(ListenerIdentity::Tunnel { client_address })) => client_address,
        None => None,
    };
    let public_host = tunnel_liveness.borrow().public_host.clone();
    let Some(served_origin) = request_host(&request)
        .and_then(|request_host| served_public_origin(request_host, public_host.as_deref()))
    else {
        return (
            StatusCode::MISDIRECTED_REQUEST,
            "request host is not this server's public host",
        )
            .into_response();
    };
    let forwarded = match tunnel_forwarded(client_address, &served_origin) {
        Ok(forwarded) => forwarded,
        Err(error) => {
            tracing::error!("tunnel request's Forwarded header can't be written: {error}");
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

/// The `https` origin `request_host` names, when it is the origin of
/// `public_host`. `None` when no public host is configured, either host
/// doesn't name an origin, or they name different ones.
fn served_public_origin(request_host: &str, public_host: Option<&str>) -> Option<Url> {
    let public_origin = public_origin_url(public_host?).ok()?;
    let request_origin = public_origin_url(request_host).ok()?;
    (request_origin.origin() == public_origin.origin()).then_some(request_origin)
}

/// The `Forwarded` header for a tunnel request served as `served_origin`, from
/// the visitor at `client_address` when the PROXY header named one.
fn tunnel_forwarded(
    client_address: Option<SocketAddr>,
    served_origin: &Url,
) -> Result<HeaderValue, axum::http::header::InvalidHeaderValue> {
    let host_and_proto = format!("host=\"{}\";proto=https", served_origin.authority());
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

    /// A liveness snapshot carrying `public_host` and nothing else of note.
    fn liveness(public_host: Option<&str>) -> watch::Receiver<TunnelLiveness> {
        let (_sender, receiver) = watch::channel(TunnelLiveness {
            settings_revision: Some(1),
            status: tunnel_rust::TunnelStatus::Off,
            origin: "http://127.0.0.1:8080".to_owned(),
            public_host: public_host.map(str::to_owned),
            error: None,
            dial_attempts: 0,
        });
        receiver
    }

    /// A router behind the layer whose handler answers with the `Forwarded`
    /// header it was handed, or `-` for none.
    fn stamping_router(public_host: Option<&str>) -> Router {
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
                liveness(public_host),
                stamp_tunnel_provenance,
            ))
    }

    fn request(listener_identity: Option<ListenerIdentity>, headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::get("/");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let mut request = builder.body(Body::empty()).expect("request");
        if let Some(listener_identity) = listener_identity {
            request.extensions_mut().insert(listener_identity);
        }
        request
    }

    fn tunnel(client_address: Option<&str>) -> Option<ListenerIdentity> {
        Some(ListenerIdentity::Tunnel {
            client_address: client_address.map(|address| address.parse().expect("address")),
        })
    }

    /// The status and the `Forwarded` header the handler saw (`-` for none).
    async fn send(public_host: Option<&str>, request: Request) -> (StatusCode, String) {
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

    #[tokio::test]
    async fn a_local_request_keeps_its_own_forwarded_header() {
        let forwarded = "for=192.0.2.1;host=front.example.com;proto=https";
        let (status, seen) = send(
            Some("dev1.example.com"),
            request(
                Some(ListenerIdentity::Local),
                &[("host", "127.0.0.1:8080"), ("forwarded", forwarded)],
            ),
        )
        .await;
        assert_eq!((status, seen.as_str()), (StatusCode::OK, forwarded));
    }

    #[tokio::test]
    async fn a_tunnel_request_is_stamped_as_the_public_origin() {
        let (status, seen) = send(
            Some("dev1.example.com"),
            request(
                tunnel(Some("192.0.2.1:4711")),
                &[("host", "dev1.example.com")],
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(seen, "for=192.0.2.1;host=\"dev1.example.com\";proto=https");

        // The stamp reads back through the shared parser as the public origin.
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(FORWARDED, HeaderValue::from_str(&seen).unwrap());
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
            Some("dev1.example.com"),
            request(
                tunnel(Some("[2001:db8::1]:4711")),
                &[("host", "dev1.example.com")],
            ),
        )
        .await;
        assert_eq!(
            seen,
            "for=\"[2001:db8::1]\";host=\"dev1.example.com\";proto=https"
        );
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(FORWARDED, HeaderValue::from_str(&seen).unwrap());
        assert_eq!(forwarded_client_address(&headers), Some("[2001:db8::1]"));
    }

    /// Without a PROXY address there is no `for`: an in-process connection
    /// names no visitor.
    #[tokio::test]
    async fn a_tunnel_request_without_a_proxy_address_has_no_for() {
        let (_, seen) = send(
            Some("dev1.example.com"),
            request(tunnel(None), &[("host", "dev1.example.com")]),
        )
        .await;
        assert_eq!(seen, "host=\"dev1.example.com\";proto=https");
    }

    /// A visitor's own `Forwarded` (here claiming another host and a different
    /// client) is replaced, not appended to.
    #[tokio::test]
    async fn a_visitor_s_forwarded_header_is_replaced() {
        let (status, seen) = send(
            Some("dev1.example.com"),
            request(
                tunnel(None),
                &[
                    ("host", "dev1.example.com"),
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
    /// spelling, a port on the public host is part of it.
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
            let (status, seen) = send(
                Some(public_host),
                request(tunnel(None), &[("host", request_host)]),
            )
            .await;
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
            (Some("dev1.example.com"), Some("dev2.example.com")),
            (Some("dev1.example.com"), Some("dev1.example.com:8443")),
            (Some("dev1.example.com:8443"), Some("dev1.example.com")),
            (Some("dev1.example.com"), Some("127.0.0.1:8080")),
            (Some("dev1.example.com"), Some("user@dev1.example.com")),
            (Some("dev1.example.com"), None),
            (None, Some("dev1.example.com")),
        ] {
            let headers: Vec<(&str, &str)> = request_host
                .map(|host| ("host", host))
                .into_iter()
                .collect();
            let (status, _) = send(public_host, request(tunnel(None), &headers)).await;
            assert_eq!(
                status,
                StatusCode::MISDIRECTED_REQUEST,
                "{public_host:?} / {request_host:?}"
            );
        }
    }

    /// A request that never came through `serve` is not trusted as local: it is
    /// held to the public host like a tunnel request.
    #[tokio::test]
    async fn a_request_without_a_listener_identity_is_treated_as_tunnel() {
        let (status, _) = send(
            Some("dev1.example.com"),
            request(None, &[("host", "127.0.0.1:8080")]),
        )
        .await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);

        let (status, seen) = send(
            Some("dev1.example.com"),
            request(
                None,
                &[
                    ("host", "dev1.example.com"),
                    ("forwarded", "for=203.0.113.9"),
                ],
            ),
        )
        .await;
        assert_eq!(
            (status, seen.as_str()),
            (StatusCode::OK, "host=\"dev1.example.com\";proto=https")
        );
    }
}
