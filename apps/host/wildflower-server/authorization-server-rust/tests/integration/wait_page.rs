//! The `/authorize` wait page: where a parked request sends the browser, and
//! how the page and its two assets are served.

use crate::common::*;

/// A `GET` of `path`, served at the server's origin.
async fn get(g: &AuthorizationServer, path: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(Request::get(path), Body::empty()))
        .await
        .expect("oneshot")
}

/// The value of `name` on `res`, which must carry it.
fn header<'a>(res: &'a axum::response::Response, name: &str) -> &'a str {
    res.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_else(|| panic!("{name} header"))
}

/// A parked request is sent to the wait page beside the endpoint it asked,
/// named relatively, and no launcher address is involved.
#[tokio::test]
async fn a_parked_request_waits_beside_the_authorize_endpoint() {
    let (g, _owner_token, db) = spin_up();

    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query("ghost", "read"),
    )
    .await;
    let authorize_url = "http://127.0.0.1/oauth/authorize";
    let request_id = parked_request_id(&res);
    let resolved = Url::parse(authorize_url)
        .and_then(|authorize| authorize.join(&location_of(&res)))
        .expect("resolves");
    assert_eq!(
        resolved.as_str(),
        format!("{authorize_url}/{request_id}/wait"),
        "the wait page is beside the authorize endpoint"
    );
    assert!(!location_of(&res).contains(LAUNCHER_BASE));
}

/// The page is the same static bytes whatever request id the path names, so an
/// id can never reach the markup, and it is served with the headers that keep
/// it to its own origin and out of caches, frames and referrers.
#[tokio::test]
async fn the_wait_page_is_static_and_locked_down() {
    let (g, _owner_token, _db) = spin_up();
    let hostile_id = "%3Cscript%3Ealert(1)%3C%2Fscript%3E";

    let ordinary = get(&g, "/oauth/authorize/req-1/wait").await;
    let hostile = get(&g, &format!("/oauth/authorize/{hostile_id}/wait")).await;

    assert_eq!(ordinary.status(), StatusCode::OK);
    assert_eq!(hostile.status(), StatusCode::OK);
    assert_eq!(
        header(&ordinary, "content-type"),
        "text/html; charset=utf-8"
    );
    let csp = header(&ordinary, "content-security-policy");
    for directive in [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
    ] {
        assert!(csp.contains(directive), "{directive} in {csp}");
    }
    assert_eq!(header(&ordinary, "referrer-policy"), "no-referrer");
    assert_eq!(header(&ordinary, "x-content-type-options"), "nosniff");
    assert_eq!(header(&ordinary, "cache-control"), "no-store");

    let ordinary_body = body_string(ordinary.into_body()).await;
    let hostile_body = body_string(hostile.into_body()).await;
    assert_eq!(ordinary_body, hostile_body);
    assert!(!hostile_body.contains("alert(1)"));
}

/// The page's `../wait.js` and `../wait.css` resolve to these two siblings, with
/// the types the page's `nosniff` requires.
#[tokio::test]
async fn the_wait_page_assets_are_served_beside_it() {
    let (g, _owner_token, _db) = spin_up();

    let page = body_string(get(&g, "/oauth/authorize/req-1/wait").await.into_body()).await;
    assert!(page.contains(r#"src="../wait.js""#), "{page}");
    assert!(page.contains(r#"href="../wait.css""#), "{page}");

    for (path, content_type) in [
        ("/oauth/authorize/wait.js", "text/javascript; charset=utf-8"),
        ("/oauth/authorize/wait.css", "text/css; charset=utf-8"),
    ] {
        let res = get(&g, path).await;
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        assert_eq!(header(&res, "content-type"), content_type, "{path}");
        assert_eq!(header(&res, "cache-control"), "no-store", "{path}");
    }
}

/// The page's check for whether this browser can open the consent card asks
/// for the browser session, as the card does, so a browser also signed
/// in to the FHIR web UI is judged as the Owner.
#[tokio::test]
async fn the_wait_page_checks_the_browser_session() {
    let (g, _host_owner_token, _db) = spin_up();

    let script = body_string(get(&g, "/oauth/authorize/wait.js").await.into_body()).await;
    let asks_for_the_owner = format!(
        "'{}': '{}'",
        wildflowerhealthio_authorization_server::SESSION_HEADER,
        wildflowerhealthio_authorization_server::BROWSER_SESSION_HEADER_VALUE
    );
    assert!(
        script.to_ascii_lowercase().contains(&asks_for_the_owner),
        "{script}"
    );
}
