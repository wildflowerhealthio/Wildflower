use std::convert::Infallible;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::HeaderMap;

use crate::http::state::AppState;

/// The origin a given request expects its answer to come from.
///
/// When a trusted front (e.g. the reverse-proxy tunnel) forwards a request it
/// sets `x-public-origin` to the public host the client actually used, and
/// `x-forwarded-proto` to that scheme; we echo those back so discovery
/// documents and minted tokens reference the URL the caller really reached.
/// With no such header the request came in over loopback, so we fall back to
/// `loopback_origin` (the value pinned in [`GatekeeperConfig`](crate::GatekeeperConfig)).
pub fn served_origin_for(headers: &HeaderMap, loopback_origin: &str) -> String {
    if let Some(public_origin) = try_get_header_str(headers, "x-public-origin") {
        let public_scheme = try_get_header_str(headers, "x-forwarded-proto").unwrap_or("https");
        return format!("{public_scheme}://{public_origin}");
    }
    loopback_origin.to_string()
}

fn try_get_header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// [`served_origin_for`] as an axum extractor: resolves the request's served
/// origin from its forwarding headers and the configured loopback origin, so a
/// handler takes `origin: ServedOrigin` instead of threading a `HeaderMap`
/// purely to call `served_origin_for`. Infallible — a request with no
/// forwarding headers falls back to `loopback_origin`.
pub(crate) struct ServedOrigin(pub String);

impl ServedOrigin {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromRequestParts<AppState> for ServedOrigin {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(ServedOrigin(served_origin_for(
            &parts.headers,
            &state.loopback_origin,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    const LOOPBACK: &str = "http://127.0.0.1:5173";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn forwarded_origin_uses_the_forwarded_scheme_and_host() {
        let headers = headers(&[
            ("x-public-origin", "emr.example.com"),
            ("x-forwarded-proto", "http"),
        ]);
        assert_eq!(
            served_origin_for(&headers, LOOPBACK),
            "http://emr.example.com"
        );
    }

    #[test]
    fn forwarded_origin_defaults_to_https_without_a_proto_header() {
        let headers = headers(&[("x-public-origin", "emr.example.com")]);
        assert_eq!(
            served_origin_for(&headers, LOOPBACK),
            "https://emr.example.com"
        );
    }

    #[test]
    fn no_forwarding_headers_falls_back_to_the_loopback_origin() {
        assert_eq!(served_origin_for(&HeaderMap::new(), LOOPBACK), LOOPBACK);
    }
}
