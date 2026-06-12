use axum::http::HeaderMap;

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
