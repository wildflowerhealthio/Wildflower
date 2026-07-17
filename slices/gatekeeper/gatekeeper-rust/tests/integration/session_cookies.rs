use crate::common::*;

/// The owner web-login path — a device-code grant — plants both session
/// cookies: the `HttpOnly` `wf_auth` carrying the very JWT returned in the body,
/// and the readable `wf_auth_exp` hint. `Max-Age` is the 15m `ACCESS_TOKEN_TTL`.
/// The test origin is http loopback (`LOOPBACK_ORIGIN`), so `Secure` is omitted
/// — the direct-loopback web path Safari must be able to store (issue #218).
#[tokio::test]
async fn device_grant_sets_session_cookies() {
    let (g, _host_owner_token, db) = spin_up();
    plant_device_request(
        &store_handle(&db),
        "wildflower-host",
        "dev-cookie",
        &[&WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
         client_id=wildflower-host&device_code=dev-cookie",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let cookies = set_cookie_values(&res);
    let token = body_json(res.into_body()).await;
    let access_token = token["access_token"].as_str().expect("access_token");

    // The HttpOnly cookie carries the exact JWT from the body with the full
    // attribute set and the 15m TTL, and NO `Secure` over http loopback.
    let auth_cookie = cookies
        .iter()
        .find(|c| c.starts_with(&format!("wf_auth={access_token};")))
        .expect("wf_auth cookie present");
    assert!(auth_cookie.contains("HttpOnly"), "wf_auth must be HttpOnly");
    assert!(auth_cookie.contains("SameSite=Lax") && auth_cookie.contains("Path=/"));
    assert!(auth_cookie.contains("Max-Age=900"));
    assert!(
        !auth_cookie.contains("Secure"),
        "http loopback must omit Secure: {auth_cookie}"
    );
    // The companion is present, readable (never HttpOnly), and shares the TTL.
    let exp_cookie = cookies
        .iter()
        .find(|c| c.starts_with("wf_auth_exp="))
        .expect("wf_auth_exp cookie present");
    assert!(
        !exp_cookie.contains("HttpOnly"),
        "companion must stay readable"
    );
    assert!(exp_cookie.contains("Max-Age=900"));
}

/// The authorization-code grant is a third-party SMART app redeeming a code —
/// it must NOT plant an owner-origin session cookie (the security decision in
/// #218). Only the JSON token comes back.
#[tokio::test]
async fn authorization_code_grant_does_not_set_session_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    plant_authorization_code(
        &store_handle(&db),
        "test-app",
        &Url::parse("https://app.example/cb").unwrap(),
        &["read"],
        "cookieless-code",
        Utc::now() + Duration::minutes(1),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=authorization_code&client_id=test-app&code=cookieless-code&\
         code_verifier=verifierverifierverifierverifierverifierabc&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&res).is_empty(),
        "auth-code grant must not set a session cookie"
    );
}

/// The owner SPA refreshing its own session — a `refresh_token` grant by the
/// first-party `wildflower-host` client — re-plants both session cookies (the
/// second of the two owner-session grants in #218).
#[tokio::test]
async fn first_party_refresh_grant_sets_session_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    // `wildflower-host` is seeded by `spin_up` (allows every grant), so only its
    // refresh-token family needs planting.
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
    let cookies = set_cookie_values(&res);
    assert!(
        cookies.iter().any(|c| c.starts_with("wf_auth=")),
        "first-party refresh must re-plant wf_auth: {cookies:?}"
    );
    assert!(cookies.iter().any(|c| c.starts_with("wf_auth_exp=")));
}

/// A third-party SMART app also redeems `refresh_token` grants, but its grant
/// must NOT plant the owner-origin session cookie: doing so would overwrite the
/// owner's `wf_auth` with the app's lower-scoped token — a session-fixation /
/// forced-downgrade vector. Cookie-planting is keyed on the *resolved* grant's
/// client (`FIRST_PARTY_CLIENT_ID`), not the wire `grant_type`, so a third-party
/// refresh returns only the JSON token. See #218.
#[tokio::test]
async fn third_party_refresh_grant_does_not_set_session_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    plant_refresh_token(
        &store_handle(&db),
        "app-refresh",
        "test-app",
        Utc::now() + Duration::days(30),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=test-app&refresh_token=app-refresh",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&res).is_empty(),
        "third-party refresh must not set a session cookie"
    );
}

/// An owner-gated route authenticates the *same* owner token whether it arrives
/// in the `Authorization` header or the `wf_auth` cookie — the middleware
/// verifies a token string regardless of source (#218).
#[tokio::test]
async fn owner_route_accepts_cookie_sourced_token_like_a_header() {
    let (g, host_owner_token, _db) = spin_up();

    let header_res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(header_res.status(), StatusCode::OK);

    let cookie_res = g
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
    assert_eq!(cookie_res.status(), StatusCode::OK);
}

/// Precedence: when a bearer header is present it is used as-is — there is no
/// fall-through to the cookie. A garbage bearer alongside a valid cookie is a
/// 401, locking the "bearer present wins" rule (#218 point 2).
#[tokio::test]
async fn bearer_header_takes_precedence_over_cookie() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", "Bearer not-a-real-token")
                .header("cookie", format!("wf_auth={host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// `POST /access/logout` is owner-gated (the cookie-sourced token satisfies the
/// gate), clears both session cookies with `Max-Age=0`, and redirects to `/`.
#[tokio::test]
async fn logout_clears_session_cookies() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/access/logout")
                .header("host", "127.0.0.1")
                .header("cookie", format!("wf_auth={host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    // 303 downgrades the POST to a GET of `/`; the clearing cookies ride along.
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        res.headers()
            .get(axum::http::header::LOCATION)
            .and_then(|v| v.to_str().ok()),
        Some("/"),
        "logout must redirect home"
    );
    let cookies = set_cookie_values(&res);
    assert!(
        cookies
            .iter()
            .any(|c| c.starts_with("wf_auth=;") && c.contains("Max-Age=0")),
        "logout must clear wf_auth: {cookies:?}"
    );
    assert!(
        cookies
            .iter()
            .any(|c| c.starts_with("wf_auth_exp=;") && c.contains("Max-Age=0")),
        "logout must clear wf_auth_exp: {cookies:?}"
    );
}
