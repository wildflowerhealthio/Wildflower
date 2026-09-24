//! The `/authorize` wait page: where a parked request sends the browser, and
//! how the page and its two assets are served. What the page's script does is
//! pinned in `gatekeeper-react/src/wait-page.test.ts`.

use crate::common::*;

/// A loopback `GET` of `path`.
async fn get(g: &Gatekeeper, path: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(Request::get(path), Body::empty()))
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
/// named relatively, so the browser stays on whichever origin it reached the
/// gatekeeper at — loopback, or a forwarded public one — and no owner UI
/// address is involved.
#[tokio::test]
async fn a_parked_request_waits_beside_the_authorize_endpoint_on_the_origin_it_used() {
    let (g, _host_owner_token, _db) = spin_up();

    let direct = get_authorize(&g.router, &authorize_query("ghost", "read")).await;
    let forwarded = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!(
                "/oauth/authorize?{}",
                authorize_query("ghost", "read")
            ))
            .header(
                "forwarded",
                "host=ruth.wildflowerhealth.example;proto=https",
            ),
            Body::empty(),
        ))
        .await
        .expect("oneshot");

    for (res, authorize_url) in [
        (direct, "http://127.0.0.1/oauth/authorize"),
        (
            forwarded,
            "https://ruth.wildflowerhealth.example/oauth/authorize",
        ),
    ] {
        let request_id = parked_request_id(&res);
        let resolved = Url::parse(authorize_url)
            .and_then(|authorize| authorize.join(&location_of(&res)))
            .expect("resolves");
        assert_eq!(
            resolved.as_str(),
            format!("{authorize_url}/{request_id}/wait"),
            "the wait page is on the origin the browser used"
        );
        assert!(!location_of(&res).contains(OWNER_UI_BASE));
    }
}

/// The page is the same static bytes whatever request id the path names, so an
/// id can never reach the markup, and it is served with the headers that keep
/// it to its own origin and out of caches, frames and referrers.
#[tokio::test]
async fn the_wait_page_is_static_and_locked_down() {
    let (g, _host_owner_token, _db) = spin_up();
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
    let (g, _host_owner_token, _db) = spin_up();

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
