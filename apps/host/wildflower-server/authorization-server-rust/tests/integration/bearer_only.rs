use crate::common::*;

// The authorization server's gates read `Authorization: Bearer` alone: no grant
// plants a session cookie, a `wf_auth` cookie authenticates nothing, and logout
// sets no cookies. The one cookie it sets, the Owner's from `/oauth/sign-in`,
// becomes a bearer in the host's cookie→bearer layer, not here. See
// `slices/authorization/docs/Auth Token Storage Explanation.md`.

/// A device grant returns its token in the JSON body only — no `Set-Cookie`
/// rides the response.
#[tokio::test]
async fn a_device_grant_sets_no_cookie() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    plant_device_request(
        &store_handle(&db),
        TEST_CLIENT_ID,
        "dev-no-cookie",
        &[TEST_CLIENT_SCOPE],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
         client_id=integration-test-app&device_code=dev-no-cookie",
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

/// A refresh grant likewise returns only the JSON token.
#[tokio::test]
async fn a_refresh_grant_sets_no_cookie() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    plant_refresh_token(
        &store_handle(&db),
        "test-refresh",
        TEST_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=integration-test-app&refresh_token=test-refresh",
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
    let (g, owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/authorization/grants")
                .header("host", "127.0.0.1")
                .header("cookie", format!("wf_auth={owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// `POST /authorization/logout` with a bearer redirects to the hosted launcher and
/// sets no cookies.
#[tokio::test]
async fn logout_redirects_to_the_launcher_without_cookies() {
    let (g, owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/authorization/logout")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        res.headers()
            .get(axum::http::header::LOCATION)
            .and_then(|v| v.to_str().ok()),
        Some(LAUNCHER_BASE),
        "logout must redirect to the hosted launcher"
    );
    assert!(
        set_cookie_values(&res).is_empty(),
        "logout must not set cookies"
    );
}
