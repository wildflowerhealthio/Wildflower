use axum::http::HeaderMap;

const DEFAULT_ORIGIN: &str = "tauri://localhost";

pub fn origin_for(headers: &HeaderMap) -> String {
    if let Some(forwarded_host) = header_str(headers, "x-forwarded-host") {
        let scheme = header_str(headers, "x-forwarded-proto").unwrap_or("http");
        return format!("{scheme}://{forwarded_host}");
    }
    if let Some(host) = header_str(headers, "host") {
        return format!("http://{host}");
    }
    DEFAULT_ORIGIN.to_string()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}
