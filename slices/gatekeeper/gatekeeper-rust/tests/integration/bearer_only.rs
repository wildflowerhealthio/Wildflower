use crate::common::*;

// The server authenticates by `Authorization: Bearer` alone: no grant plants a
// session cookie, a `wf_auth` cookie authenticates nothing, and logout sets no
// cookies. See `slices/gatekeeper/docs/Auth Token Storage Explanation.md`.

/// The first-party host's device login returns its token in the JSON body only
/// — no `Set-Cookie` rides the response.
#[tokio::test]
async fn first_party_device_grant_sets_no_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    plant_device_request(
        &store_handle(&db),
        "wildflower-host",
        "dev-no-cookie",
        &[&WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
         client_id=wildflower-host&device_code=dev-no-cookie",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&res).is_empty(),
        "the device grant must not set a cookie"
    );
    let token = body_json(res.into_body()).await;
    assert!(token["access_token"].as_str().is_some());
}

/// The first-party host's refresh grant likewise returns only the JSON token.
#[tokio::test]
async fn first_party_refresh_grant_sets_no_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    plant_refresh_token(
        &store_handle(&db),
        "owner-refresh",
        "wildflower-host",
        Utc::now() + Duration::days(30),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=wildflower-host&refresh_token=owner-refresh",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&res).is_empty(),
        "the refresh grant must not set a cookie"
    );
}

/// A valid owner token presented as a `wf_auth` cookie, with no bearer header,
/// is unauthenticated: the cookie is not a credential.
#[tokio::test]
async fn a_cookie_carried_token_is_not_a_credential() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("cookie", format!("wf_auth={host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// `POST /access/logout` with a bearer redirects to the hosted owner UI and
/// sets no cookies.
#[tokio::test]
async fn logout_redirects_to_the_owner_ui_without_cookies() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/access/logout")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        res.headers()
            .get(axum::http::header::LOCATION)
            .and_then(|v| v.to_str().ok()),
        Some(OWNER_UI_BASE),
        "logout must redirect to the hosted owner UI"
    );
    assert!(
        set_cookie_values(&res).is_empty(),
        "logout must not set cookies"
    );
}
