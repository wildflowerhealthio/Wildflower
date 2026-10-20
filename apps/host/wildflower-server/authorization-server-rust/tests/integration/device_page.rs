//! The device verification page: `/oauth/device_authorization` sends the user
//! to `/oauth/device` on the server's origin, which
//! serves the page, and the page decides the request through the
//! `/authorization/devices/{userCode}` API on the browser session's bearer, the
//! token its session cookie holds. The cookie→bearer layer that presents that
//! token for the page is the host's (`wildflower-server-rust`), so these tests
//! send it as the bearer themselves.

use crate::common::*;

/// The codes `/oauth/device_authorization` answers the test client with.
struct DeviceAuthorization {
    /// The secret the device polls `/oauth/token` with.
    device_code: String,
    /// The short code the user carries to the device page.
    user_code: String,
    /// The device page's address with the user code already in its query, for
    /// a device that can show a link or QR code.
    verification_uri_complete: String,
}

/// Start the device flow for the test client.
async fn start_device_flow(g: &AuthorizationServer) -> DeviceAuthorization {
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::post("/oauth/device_authorization")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from("client_id=integration-test-app&scope=system%2F*.cruds"),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    let field = |name: &str| body[name].as_str().expect(name).to_owned();
    DeviceAuthorization {
        device_code: field("device_code"),
        user_code: field("user_code"),
        verification_uri_complete: field("verification_uri_complete"),
    }
}

/// `method` on `path` (an `/authorization/devices/…` route) with a JSON
/// `body`, on `bearer` when there is one.
async fn device_consent_request(
    g: &AuthorizationServer,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: &'static str,
) -> axum::response::Response {
    let builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    let builder = match bearer {
        Some(bearer) => builder.header("authorization", format!("Bearer {bearer}")),
        None => builder,
    };
    g.router
        .clone()
        .oneshot(build_request(builder, Body::from(body)))
        .await
        .expect("oneshot")
}

/// The device's token poll for `device_code`.
async fn poll(g: &AuthorizationServer, device_code: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(format!(
                "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                 client_id={TEST_CLIENT_ID}&device_code={device_code}"
            )),
        ))
        .await
        .expect("oneshot")
}

/// `verification_uri_complete` names a page on the server's own origin, and
/// that page is served as HTML, uncached, under a content security policy.
#[tokio::test]
async fn verification_uri_complete_serves_the_device_page_on_the_server_origin() {
    let (g, _host_owner_token, db) = spin_up();
    seed_test_client(&db);
    let started = start_device_flow(&g).await;

    let page_url = Url::parse(&started.verification_uri_complete).expect("a URL");
    assert_eq!(page_url.origin().ascii_serialization(), SERVER_ORIGIN);
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get(format!(
                "{}?{}",
                page_url.path(),
                page_url.query().expect("the code")
            )),
            Body::empty(),
        ))
        .await
        .expect("oneshot");

    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()["content-type"].to_str().expect("ascii"),
        "text/html; charset=utf-8"
    );
    assert_eq!(
        res.headers()["cache-control"].to_str().expect("ascii"),
        "no-store"
    );
    assert!(res
        .headers()
        .contains_key(axum::http::header::CONTENT_SECURITY_POLICY));
}

/// A browser signed in as the Owner reads and approves the device request on
/// its session's bearer, and the device's next poll earns a token for the
/// approved scope.
#[tokio::test]
async fn a_browser_session_approves_the_code_and_the_device_poll_succeeds() {
    let (g, _host_owner_token, db) = spin_up();
    seed_test_client(&db);
    let started = start_device_flow(&g).await;
    let same_device_session_token = signed_in_same_device_session_token(&g).await;
    let consent_path = format!("/authorization/devices/{}", started.user_code);

    let read = device_consent_request(
        &g,
        "GET",
        &consent_path,
        Some(&same_device_session_token),
        "",
    )
    .await;
    assert_eq!(read.status(), StatusCode::OK);
    assert_eq!(
        body_json(read.into_body()).await["userCode"],
        started.user_code
    );

    let approve = device_consent_request(
        &g,
        "POST",
        &format!("{consent_path}/approve"),
        Some(&same_device_session_token),
        r#"{"approvedScopes":["system/*.cruds"]}"#,
    )
    .await;
    assert_eq!(approve.status(), StatusCode::OK);
    assert_eq!(
        body_json(approve.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );

    let token = poll(&g, &started.device_code).await;
    assert_eq!(token.status(), StatusCode::OK);
    assert_eq!(
        body_json(token.into_body()).await["scope"],
        TEST_CLIENT_SCOPE
    );
}

/// Without a bearer, reading or approving the device request is `401`, and the
/// device's poll still hears `authorization_pending`.
#[tokio::test]
async fn without_a_session_the_request_is_left_pending() {
    let (g, _host_owner_token, db) = spin_up();
    seed_test_client(&db);
    let started = start_device_flow(&g).await;
    let consent_path = format!("/authorization/devices/{}", started.user_code);

    let read = device_consent_request(&g, "GET", &consent_path, None, "").await;
    assert_eq!(read.status(), StatusCode::UNAUTHORIZED);
    let approve = device_consent_request(
        &g,
        "POST",
        &format!("{consent_path}/approve"),
        None,
        r#"{"approvedScopes":["system/*.cruds"]}"#,
    )
    .await;
    assert_eq!(approve.status(), StatusCode::UNAUTHORIZED);

    let token = poll(&g, &started.device_code).await;
    assert_eq!(token.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(token.into_body()).await,
        serde_json::json!({ "error": "authorization_pending" })
    );
}

/// A user code that names no request is a `404 DeviceConsentNotFound`
/// naming the code.
#[tokio::test]
async fn an_unknown_code_is_not_found_for_the_browser_session() {
    let (g, _host_owner_token, db) = spin_up();
    seed_test_client(&db);
    let same_device_session_token = signed_in_same_device_session_token(&g).await;

    let read = device_consent_request(
        &g,
        "GET",
        "/authorization/devices/NOPE-NOPE",
        Some(&same_device_session_token),
        "",
    )
    .await;

    assert_eq!(read.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(read.into_body()).await,
        serde_json::json!({ "error": "DeviceConsentNotFound", "userCode": "NOPE-NOPE" })
    );
}
