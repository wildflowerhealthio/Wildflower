//! The API router's fallback: every route no slice claimed answers `404`, with a
//! link to the hosted launcher ([`LauncherBase`]) pointed back at this server's
//! origin and returning to the path asked for — so a browser that lands
//! on, say, the server's bare domain is told where to go.
//!
//! Browsers (an `Accept` naming `text/html`) get a small HTML page with the link;
//! everything else gets the API's usual structured error body,
//! `{ "error": "RouteNotFound", … }` — the shape each slice's `*NotFound`
//! responses take (`error` tag, camelCase fields).
//!
//! The launcher's entry route ([`APP_ENTRY_PATHS`]) is the exception: a browser
//! `GET` of it is plainly someone opening the app, so it is sent straight there
//! with a `303` rather than shown a page to click through. (A browser opening
//! the root goes to the FHIR web UI instead; see `root_fallback.rs`.)

use std::sync::Arc;

use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Json, Redirect, Response};
use serde::Serialize;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// Launcher routes a browser opening this server most likely wants: the home
/// screen. A browser `GET` of one redirects to the same route on the hosted
/// launcher, pointed at this server.
const APP_ENTRY_PATHS: [&str; 1] = ["/home"];

/// What the fallback needs to point a lost browser at the hosted launcher.
pub(crate) struct NotFoundConfig {
    /// The hosted launcher the link opens.
    pub(crate) launcher_base: LauncherBase,
    /// The server's bare origin, `https://<domain>`, which the link points the
    /// launcher at.
    pub(crate) server_origin: String,
}

/// Wire shape of the JSON `404` for a route no slice serves.
#[derive(Debug, Serialize)]
struct RouteNotFoundBody {
    error: &'static str,
    /// The origin-relative path (query included) that matched nothing.
    path: String,
    /// The hosted launcher, pointed at this server and returning to `path`.
    #[serde(rename = "openInApp")]
    open_in_app: String,
}

/// Build the fallback handler over `config`.
pub(crate) fn fallback(
    config: Arc<NotFoundConfig>,
) -> impl Fn(Method, HeaderMap, Uri) -> std::future::Ready<Response> + Clone + Send + Sync + 'static
{
    move |method, headers, uri| std::future::ready(respond(&config, &method, &headers, &uri))
}

/// The response for an unmatched `uri`: a redirect into the launcher for a
/// browser opening one of its [`APP_ENTRY_PATHS`], else the `404`, as HTML or
/// JSON per the `Accept` header.
fn respond(config: &NotFoundConfig, method: &Method, headers: &HeaderMap, uri: &Uri) -> Response {
    let is_browser_navigation =
        (method == Method::GET || method == Method::HEAD) && accepts_html(headers);
    if is_browser_navigation && APP_ENTRY_PATHS.contains(&uri.path()) {
        let target = config
            .launcher_base
            .route_url(uri.path(), &config.server_origin, &[]);
        return Redirect::to(target.as_str()).into_response();
    }

    let path = uri
        .path_and_query()
        .map_or_else(|| uri.path().to_owned(), |pq| pq.as_str().to_owned());
    let open_in_app = config
        .launcher_base
        .open_url(&config.server_origin, &path)
        .to_string();

    if accepts_html(headers) {
        (StatusCode::NOT_FOUND, Html(html_page(&path, &open_in_app))).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(RouteNotFoundBody {
                error: "RouteNotFound",
                path,
                open_in_app,
            }),
        )
            .into_response()
    }
}

/// Whether the caller will render HTML — a browser navigation sends
/// `Accept: text/html,…`; `fetch` and API clients don't ask for it.
pub(crate) fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|media| {
            media
                .split(';')
                .next()
                .is_some_and(|m| m.trim() == "text/html")
        })
}

fn html_page(path: &str, open_in_app: &str) -> String {
    let href = escape_html(open_in_app);
    format!(
        "<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>Not found · Wildflower</title>
  <style>
    body {{ font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem; line-height: 1.5; }}
    code, a {{ overflow-wrap: anywhere; }}
  </style>
</head>
<body>
  <h1>Nothing here</h1>
  <p>This Wildflower server has nothing at <code>{path}</code>.</p>
  <p>Try opening it in the Wildflower app:</p>
  <p><a href=\"{href}\">{href}</a></p>
</body>
</html>
",
        path = escape_html(path),
    )
}

/// Escape the five HTML-significant characters, so a request path (attacker
/// controlled) renders as text and can't break out of the attribute or element.
fn escape_html(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(c),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::{escape_html, respond, NotFoundConfig};
    use axum::body::to_bytes;
    use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
    use wildflowerhealthio_shared_structures::launcher::LauncherBase;

    fn config() -> NotFoundConfig {
        NotFoundConfig {
            launcher_base: LauncherBase::parse("https://launcher.test/launcher/")
                .expect("valid base"),
            server_origin: "https://ruth.relay.example".to_owned(),
        }
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).expect("header value"));
        }
        map
    }

    async fn body_text(response: axum::response::Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        String::from_utf8(bytes.to_vec()).expect("utf-8 body")
    }

    #[tokio::test]
    async fn api_clients_get_the_structured_route_not_found_body() {
        let uri: Uri = "/settings/requests?tab=a".parse().expect("uri");
        let response = respond(&config(), &Method::GET, &headers(&[]), &uri);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: serde_json::Value =
            serde_json::from_str(&body_text(response).await).expect("json");
        assert_eq!(
            body,
            serde_json::json!({
                "error": "RouteNotFound",
                "path": "/settings/requests?tab=a",
                "openInApp": "https://launcher.test/launcher/\
                    ?server=https%3A%2F%2Fruth.relay.example\
                    &returnTo=%2Fsettings%2Frequests%3Ftab%3Da",
            })
        );
    }

    #[tokio::test]
    async fn browsers_get_an_html_page_linking_to_the_hosted_ui() {
        let uri: Uri = "/settings/requests".parse().expect("uri");
        let response = respond(
            &config(),
            &Method::GET,
            &headers(&[("accept", BROWSER_ACCEPT)]),
            &uri,
        );
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/html")));
        let html = body_text(response).await;
        assert!(html.contains(
            "href=\"https://launcher.test/launcher/?server=https%3A%2F%2Fruth.relay.example&amp;returnTo=%2Fsettings%2Frequests\""
        ));
    }

    const BROWSER_ACCEPT: &str = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

    fn location(response: &axum::response::Response) -> &str {
        response
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .expect("a Location header")
    }

    #[test]
    fn a_browser_opening_home_is_sent_to_the_app() {
        let uri: Uri = "/home".parse().expect("uri");
        let response = respond(
            &config(),
            &Method::GET,
            &headers(&[("accept", BROWSER_ACCEPT)]),
            &uri,
        );
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            location(&response),
            "https://launcher.test/launcher/home?server=https%3A%2F%2Fruth.relay.example"
        );
    }

    #[test]
    fn only_browser_gets_of_the_entry_paths_redirect() {
        let status = |method: Method, accept: Option<&str>, path: &str| {
            let uri: Uri = path.parse().expect("uri");
            let pairs: Vec<(&'static str, &str)> =
                accept.map(|a| vec![("accept", a)]).unwrap_or_default();
            respond(&config(), &method, &headers(&pairs), &uri).status()
        };
        // An API client asking for `/`, a browser POST to `/home`, and a browser
        // GET of any other path all still get the 404.
        assert_eq!(status(Method::GET, None, "/"), StatusCode::NOT_FOUND);
        assert_eq!(
            status(Method::POST, Some(BROWSER_ACCEPT), "/home"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status(Method::GET, Some(BROWSER_ACCEPT), "/home/extra"),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn escape_html_neutralises_markup() {
        assert_eq!(
            escape_html("/<script>alert('x')</script>?a=\"b\"&c"),
            "/&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;?a=&quot;b&quot;&amp;c"
        );
    }
}
