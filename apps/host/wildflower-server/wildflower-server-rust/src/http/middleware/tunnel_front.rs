//! The tunnel listener's front: the layer of the tunnel router, outside all
//! but CORS, that holds each tunnel request to the server's domain and drops
//! the forwarding headers the visitor wrote. Every request inside it is served
//! at the server's origin, `https://<domain>`.

use axum::extract::{Request, State};
use axum::http::header::{FORWARDED, HOST};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use url::Url;
use wildflowerhealthio_tunnel::public_origin_url;

/// The body of the `421` a request naming another host gets.
const MISDIRECTED_BODY: &str = "request host is not this server's domain";

/// Answer a request on the tunnel listener whose host isn't the server's
/// domain `421 Misdirected Request`, and pass every other one on without its
/// forwarding headers.
///
/// # Remarks
///
/// Nothing on the path from the visitor vouches for a tunnel request's
/// headers: the relay forwards bytes and the visitor writes the rest. The host
/// is accepted only when it names the domain, compared as `https` origins so
/// case and a spelled-out `:443` don't matter, and a domain with a port needs
/// that port. Every host the request names must: each `Host` header, and the
/// request target's authority when it has one (an absolute-form HTTP/1.1
/// target, or HTTP/2's `:authority`), so no reader of either sees another
/// host. A request with no host names no origin this server answers as, and is
/// refused the same way. Nothing inside reads the request's host for its
/// origin: every reader takes the server's configured origin.
///
/// A `Forwarded` or `X-Forwarded-*` header is the visitor's own claim about a
/// proxy that never handled the request, so it is dropped here, and no layer
/// inside, nor HFS, sees a visitor-supplied one.
pub(crate) async fn refuse_misdirected_requests(
    State(public_origin): State<Url>,
    mut request: Request,
    next: Next,
) -> Response {
    if !names_only_public_origin(&request, &public_origin) {
        return (StatusCode::MISDIRECTED_REQUEST, MISDIRECTED_BODY).into_response();
    }
    remove_forwarding_headers(request.headers_mut());
    next.run(request).await
}

/// Remove every `Forwarded` and `X-Forwarded-*` header from `headers`.
fn remove_forwarding_headers(headers: &mut HeaderMap) {
    let forwarding_header_names: Vec<_> = headers
        .keys()
        .filter(|name| *name == FORWARDED || name.as_str().starts_with("x-forwarded-"))
        .cloned()
        .collect();
    for name in forwarding_header_names {
        headers.remove(name);
    }
}

/// Whether `request` names a host, and every host it names is
/// `public_origin`'s: each `Host` header value, and the request target's
/// authority (HTTP/2 carries its host there and may send no `Host`).
fn names_only_public_origin(request: &Request, public_origin: &Url) -> bool {
    let host_headers = request
        .headers()
        .get_all(HOST)
        .iter()
        .map(|host| host.to_str().ok());
    let target_authority = request
        .uri()
        .authority()
        .map(|authority| Some(authority.as_str()));
    let mut request_hosts = host_headers.chain(target_authority).peekable();
    request_hosts.peek().is_some()
        && request_hosts.all(|request_host| {
            request_host
                .and_then(|request_host| public_origin_url(request_host).ok())
                .is_some_and(|request_origin| request_origin.origin() == public_origin.origin())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    /// The domain most cases are served at.
    const DOMAIN: &str = "dev1.example.com";

    /// A router behind the layer, for the server at `domain`, whose handler
    /// answers `ok`.
    fn front_router(domain: &str) -> Router {
        Router::new().route("/", get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state(
                public_origin_url(domain).expect("public origin"),
                refuse_misdirected_requests,
            ),
        )
    }

    /// A router behind the layer, for the server at [`DOMAIN`], whose
    /// handler answers the names of the forwarding headers it received.
    fn forwarding_header_echo_router() -> Router {
        Router::new()
            .route(
                "/",
                get(|headers: HeaderMap| async move {
                    let mut forwarding_header_names: Vec<_> = headers
                        .keys()
                        .map(|name| name.as_str())
                        .filter(|name| *name == "forwarded" || name.starts_with("x-forwarded-"))
                        .collect();
                    forwarding_header_names.sort_unstable();
                    forwarding_header_names.join(",")
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                public_origin_url(DOMAIN).expect("public origin"),
                refuse_misdirected_requests,
            ))
    }

    /// A tunnel request for the request target `uri`, with `headers`.
    fn tunnel_request_for(uri: &str, headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::get(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).expect("request")
    }

    /// A tunnel request for `/`, with `headers`.
    fn tunnel_request(headers: &[(&str, &str)]) -> Request {
        tunnel_request_for("/", headers)
    }

    /// The status and body of the answer to `request`.
    async fn send(domain: &str, request: Request) -> (StatusCode, String) {
        let response = front_router(domain)
            .oneshot(request)
            .await
            .expect("oneshot");
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, String::from_utf8(body.to_vec()).expect("utf-8"))
    }

    /// Hosts are compared as `https` origins: case and the default port are
    /// spelling, a port on the domain is part of it.
    #[tokio::test]
    async fn the_host_matches_the_domain_as_an_origin() {
        for (domain, request_host) in [
            ("dev1.example.com", "dev1.example.com"),
            ("dev1.example.com", "DEV1.Example.COM"),
            ("dev1.example.com", "dev1.example.com:443"),
            ("Dev1.Example.com", "dev1.example.com"),
            ("dev1.example.com:8443", "dev1.example.com:8443"),
        ] {
            let (status, body) = send(domain, tunnel_request(&[("host", request_host)])).await;
            assert_eq!(
                (status, body.as_str()),
                (StatusCode::OK, "ok"),
                "{domain} / {request_host}"
            );
        }
    }

    #[tokio::test]
    async fn a_host_that_isn_t_the_domain_is_misdirected() {
        for (domain, request_host) in [
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
            let (status, body) = send(domain, tunnel_request(&headers)).await;
            assert_eq!(
                (status, body.as_str()),
                (StatusCode::MISDIRECTED_REQUEST, MISDIRECTED_BODY),
                "{domain} / {request_host:?}"
            );
        }
    }

    /// The request target's authority counts as a host the request names:
    /// alone (HTTP/2, no `Host`) it must be the domain, and next to a
    /// `Host` both must be.
    #[tokio::test]
    async fn the_target_authority_must_name_the_domain_too() {
        let (status, body) =
            send(DOMAIN, tunnel_request_for("https://dev1.example.com/", &[])).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "ok"));
        for (uri, headers) in [
            ("https://dev2.example.com/", &[][..]),
            ("https://dev2.example.com/", &[("host", DOMAIN)][..]),
            (
                "https://dev1.example.com/",
                &[("host", "dev2.example.com")][..],
            ),
        ] {
            let (status, body) = send(DOMAIN, tunnel_request_for(uri, headers)).await;
            assert_eq!(
                (status, body.as_str()),
                (StatusCode::MISDIRECTED_REQUEST, MISDIRECTED_BODY),
                "{uri} / {headers:?}"
            );
        }
    }

    /// A second `Host` naming another host is misdirected, whichever comes
    /// first.
    #[tokio::test]
    async fn every_host_header_must_name_the_domain() {
        for headers in [
            [("host", DOMAIN), ("host", "dev2.example.com")],
            [("host", "dev2.example.com"), ("host", DOMAIN)],
        ] {
            let (status, body) = send(DOMAIN, tunnel_request(&headers)).await;
            assert_eq!(
                (status, body.as_str()),
                (StatusCode::MISDIRECTED_REQUEST, MISDIRECTED_BODY),
                "{headers:?}"
            );
        }
    }

    /// The visitor's `Forwarded` and `X-Forwarded-*` headers never reach the
    /// layers inside.
    #[tokio::test]
    async fn forwarding_headers_are_dropped() {
        let request = tunnel_request(&[
            ("host", DOMAIN),
            (
                "forwarded",
                "for=192.0.2.1;host=dev2.example.com;proto=http",
            ),
            ("forwarded", "for=192.0.2.2"),
            ("x-forwarded-for", "192.0.2.1"),
            ("x-forwarded-host", "dev2.example.com"),
            ("x-forwarded-proto", "http"),
        ]);
        let response = forwarding_header_echo_router()
            .oneshot(request)
            .await
            .expect("oneshot");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(body.as_ref(), b"");
    }
}
