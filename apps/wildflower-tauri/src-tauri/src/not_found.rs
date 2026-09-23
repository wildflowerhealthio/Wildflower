//! The API router's fallback: every route no slice claimed answers `404`, with a
//! link to the hosted owner UI ([`OwnerUiBase`]) pointed back at this server's
//! served origin and returning to the path asked for — so a browser that lands
//! on, say, the tunnel's bare public host is told where to go.
//!
//! Browsers (an `Accept` naming `text/html`) get a small HTML page with the link;
//! everything else gets the API's usual structured error body,
//! `{ "error": "RouteNotFound", … }` — the shape each slice's `*NotFound`
//! responses take (`error` tag, camelCase fields).
//!
//! The owner UI's entry routes ([`APP_ENTRY_PATHS`]) are the exception: a browser
//! `GET` of one is plainly someone opening the app, so it is sent straight there
//! with a `303` rather than shown a page to click through.

use std::sync::Arc;

use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Json, Redirect, Response};
use serde::Serialize;
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::served_origin::served_base_url_for;
use url::Url;

/// Owner-UI routes a browser opening this server most likely wants: the root and
/// the home screen. A browser `GET` of one redirects to the same route on the
/// hosted owner UI, pointed at this server.
const APP_ENTRY_PATHS: [&str; 2] = ["/", "/home"];

/// What the fallback needs to point a lost browser at the hosted owner UI.
pub struct NotFoundConfig {
    /// The hosted owner UI the link opens.
    pub owner_ui_base: OwnerUiBase,
    /// The loopback base URL, the served origin of an unforwarded request (see
    /// [`served_base_url_for`]).
    pub loopback_base_url: Url,
}

/// Wire shape of the JSON `404` for a route no slice serves.
#[derive(Debug, Serialize)]
struct RouteNotFoundBody {
    error: &'static str,
    /// The origin-relative path (query included) that matched nothing.
    path: String,
    /// The hosted owner UI, pointed at this server and returning to `path`.
    /// Absent only when the request's served origin can't be resolved (a
    /// malformed `Forwarded` header), where no link back to it can be built.
    #[serde(rename = "openInApp", skip_serializing_if = "Option::is_none")]
    open_in_app: Option<String>,
}

/// Build the fallback handler over `config`.
pub fn fallback(
    config: Arc<NotFoundConfig>,
) -> impl Fn(Method, HeaderMap, Uri) -> std::future::Ready<Response> + Clone + Send + Sync + 'static
{
    move |method, headers, uri| std::future::ready(respond(&config, &method, &headers, &uri))
}

/// The response for an unmatched `uri`: a redirect into the owner UI for a
/// browser opening one of its [`APP_ENTRY_PATHS`], else the `404`, as HTML or
/// JSON per the `Accept` header.
fn respond(config: &NotFoundConfig, method: &Method, headers: &HeaderMap, uri: &Uri) -> Response {
    // Resolved per request, like every other served-origin consumer: over the
    // tunnel the links must name the public origin, not loopback.
    let served_origin = served_base_url_for(headers, &config.loopback_base_url)
        .map(|served| shared_structures_rust::origin_string(&served));
    let is_browser_navigation =
        (method == Method::GET || method == Method::HEAD) && accepts_html(headers);
    if let Some(origin) = served_origin.as_deref() {
        if is_browser_navigation && APP_ENTRY_PATHS.contains(&uri.path()) {
            let target = config.owner_ui_base.route_url(uri.path(), origin, &[]);
            return Redirect::to(target.as_str()).into_response();
        }
    }

    let path = uri
        .path_and_query()
        .map_or_else(|| uri.path().to_owned(), |pq| pq.as_str().to_owned());
    let open_in_app = served_origin
        .as_deref()
        .map(|origin| config.owner_ui_base.open_url(origin, &path).to_string());

    if accepts_html(headers) {
        (
            StatusCode::NOT_FOUND,
            Html(html_page(&path, open_in_app.as_deref())),
        )
            .into_response()
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
fn accepts_html(headers: &HeaderMap) -> bool {
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

fn html_page(path: &str, open_in_app: Option<&str>) -> String {
    let suggestion = open_in_app.map_or_else(
        || "<p>Open it from the Wildflower app instead.</p>".to_owned(),
        |url| {
            let href = escape_html(url);
            format!(
                "<p>Try opening it in the Wildflower app:</p>\n  <p><a href=\"{href}\">{href}</a></p>"
            )
        },
    );
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
  {suggestion}
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
    use shared_structures_rust::owner_ui::OwnerUiBase;
    use url::Url;

    fn config() -> NotFoundConfig {
        NotFoundConfig {
            owner_ui_base: OwnerUiBase::parse("https://owner-ui.test/app/").expect("valid base"),
            loopback_base_url: Url::parse("http://127.0.0.1:8080/").expect("valid loopback"),
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
        let uri: Uri = "/settings/tunnel?tab=a".parse().expect("uri");
        let response = respond(&config(), &Method::GET, &headers(&[]), &uri);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: serde_json::Value =
            serde_json::from_str(&body_text(response).await).expect("json");
        assert_eq!(
            body,
            serde_json::json!({
                "error": "RouteNotFound",
                "path": "/settings/tunnel?tab=a",
                "openInApp": "https://owner-ui.test/app/\
                    ?server=http%3A%2F%2F127.0.0.1%3A8080\
                    &returnTo=%2Fsettings%2Ftunnel%3Ftab%3Da",
            })
        );
    }

    #[tokio::test]
    async fn browsers_get_an_html_page_linking_to_the_hosted_ui() {
        let uri: Uri = "/settings/tunnel".parse().expect("uri");
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
            "href=\"https://owner-ui.test/app/?server=http%3A%2F%2F127.0.0.1%3A8080&amp;returnTo=%2Fsettings%2Ftunnel\""
        ));
    }

    #[tokio::test]
    async fn a_forwarded_request_links_back_to_its_public_origin() {
        let uri: Uri = "/".parse().expect("uri");
        let response = respond(
            &config(),
            &Method::GET,
            &headers(&[(
                "forwarded",
                "for=1.2.3.4;host=abc.tunnel.example;proto=https",
            )]),
            &uri,
        );
        let body: serde_json::Value =
            serde_json::from_str(&body_text(response).await).expect("json");
        assert_eq!(
            body["openInApp"],
            "https://owner-ui.test/app/?server=https%3A%2F%2Fabc.tunnel.example&returnTo=%2F"
        );
    }

    #[tokio::test]
    async fn an_unresolvable_forwarded_origin_still_404s_without_a_link() {
        let uri: Uri = "/x".parse().expect("uri");
        let response = respond(
            &config(),
            &Method::GET,
            &headers(&[("forwarded", "for=1.2.3.4")]),
            &uri,
        );
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: serde_json::Value =
            serde_json::from_str(&body_text(response).await).expect("json");
        assert_eq!(
            body,
            serde_json::json!({ "error": "RouteNotFound", "path": "/x" })
        );
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
    fn a_browser_opening_the_root_or_home_is_sent_to_the_app() {
        for (path, expected) in [
            (
                "/",
                "https://owner-ui.test/app/?server=http%3A%2F%2F127.0.0.1%3A8080",
            ),
            (
                "/home",
                "https://owner-ui.test/app/home?server=http%3A%2F%2F127.0.0.1%3A8080",
            ),
        ] {
            let uri: Uri = path.parse().expect("uri");
            let response = respond(
                &config(),
                &Method::GET,
                &headers(&[("accept", BROWSER_ACCEPT)]),
                &uri,
            );
            assert_eq!(response.status(), StatusCode::SEE_OTHER, "{path}");
            assert_eq!(location(&response), expected, "{path}");
        }
    }

    #[test]
    fn a_forwarded_browser_is_sent_to_the_app_pointed_at_the_public_origin() {
        let uri: Uri = "/home".parse().expect("uri");
        let response = respond(
            &config(),
            &Method::GET,
            &headers(&[
                ("accept", BROWSER_ACCEPT),
                (
                    "forwarded",
                    "for=1.2.3.4;host=abc.tunnel.example;proto=https",
                ),
            ]),
            &uri,
        );
        assert_eq!(
            location(&response),
            "https://owner-ui.test/app/home?server=https%3A%2F%2Fabc.tunnel.example"
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
