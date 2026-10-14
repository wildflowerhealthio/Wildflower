use crate::common::*;

// `GET /oauth/sign-in?code=…&next=…`: a code the base minted in-process signs
// a browser in as the Owner, once, handing it an Owner token as its
// `__Host-owner_browser_session` cookie and sending it on to an allowed `next`.

/// `GET /oauth/sign-in` with `code` and `next`, as the browser the base opened
/// sends it.
async fn sign_in(g: &AuthorizationServer, code: &str, next: &str) -> axum::response::Response {
    let uri = format!(
        "/oauth/sign-in?{}",
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("code", code)
            .append_pair("next", next)
            .finish()
    );
    g.router
        .clone()
        .oneshot(loopback_request(Request::get(uri), Body::empty()))
        .await
        .expect("oneshot")
}

/// The Owner token a sign-in's `Set-Cookie` hands the browser.
fn owner_browser_session_token(res: &axum::response::Response) -> String {
    let cookies = set_cookie_values(res);
    let [cookie] = cookies.as_slice() else {
        panic!("exactly one cookie, got {cookies:?}");
    };
    cookie
        .strip_prefix("__Host-owner_browser_session=")
        .and_then(|rest| rest.split(';').next())
        .unwrap_or_else(|| panic!("the Owner browser session cookie, got {cookie}"))
        .to_owned()
}

/// A token's payload claims, unverified.
fn claims_of(token: &str) -> Value {
    let payload_b64 = token.split('.').nth(1).expect("jwt has a payload segment");
    let payload = base64::url_safe_no_pad_decode(payload_b64).expect("payload is base64url");
    serde_json::from_slice(&payload).expect("payload is json")
}

/// Assert `res` is the sign-in's error page: no cookie, and no redirect.
async fn assert_refused(res: axum::response::Response, what: &str) {
    assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{what}");
    assert!(set_cookie_values(&res).is_empty(), "{what}: no cookie");
    assert!(
        res.headers().get(axum::http::header::LOCATION).is_none(),
        "{what}: no redirect"
    );
    assert!(
        body_string(res.into_body()).await.contains("<h1>"),
        "{what}: an error page"
    );
}

#[tokio::test]
async fn a_code_signs_in_once() {
    let (g, _host_owner_token, _db) = spin_up();
    let code = g.same_device_sign_in_code_minter.mint();

    let signed_in = sign_in(&g, &code, "/").await;
    assert_eq!(signed_in.status(), StatusCode::SEE_OTHER);
    assert_cache_suppressed(&signed_in, "the sign-in");
    owner_browser_session_token(&signed_in);

    assert_refused(sign_in(&g, &code, "/").await, "a spent code").await;
}

#[tokio::test]
async fn an_unknown_code_signs_nobody_in() {
    let (g, _host_owner_token, _db) = spin_up();
    let _outstanding = g.same_device_sign_in_code_minter.mint();
    assert_refused(sign_in(&g, "no-such-code", "/").await, "an unknown code").await;
    assert_refused(
        g.router
            .clone()
            .oneshot(loopback_request(
                Request::get("/oauth/sign-in"),
                Body::empty(),
            ))
            .await
            .expect("oneshot"),
        "no code",
    )
    .await;
}

#[tokio::test]
async fn the_browser_goes_on_to_an_allowed_next() {
    let (g, _host_owner_token, _db) = spin_up();
    for (next, location) in [
        (
            "/oauth/authorize/req-1/consent",
            "/oauth/authorize/req-1/consent",
        ),
        (
            "https://launcher.test/launcher/?server=https%3A%2F%2Fruth.relay.example",
            "https://launcher.test/launcher/?server=https%3A%2F%2Fruth.relay.example",
        ),
        (
            "https://authorization.test/authorization/?iss=https%3A%2F%2Fruth.relay.example",
            "https://authorization.test/authorization/?iss=https%3A%2F%2Fruth.relay.example",
        ),
    ] {
        let code = g.same_device_sign_in_code_minter.mint();
        let res = sign_in(&g, &code, next).await;
        assert_eq!(res.status(), StatusCode::SEE_OTHER, "{next}");
        assert_eq!(
            res.headers()
                .get(axum::http::header::LOCATION)
                .and_then(|value| value.to_str().ok()),
            Some(location),
            "{next}"
        );
    }
}

#[tokio::test]
async fn a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable() {
    let (g, _host_owner_token, _db) = spin_up();
    let code = g.same_device_sign_in_code_minter.mint();
    for next in [
        "//evil.example/",
        "/\\evil.example",
        "https://evil.example/",
        "https://launcher.test/elsewhere/",
        SERVER_ORIGIN,
        "",
    ] {
        assert_refused(sign_in(&g, &code, next).await, next).await;
    }
    assert_eq!(
        sign_in(&g, &code, "/").await.status(),
        StatusCode::SEE_OTHER,
        "the code is still redeemable"
    );
}

/// The cookie carries exactly the Owner browser session's attributes, and its value is
/// an Owner token: the first-party client holding the host Owner's grant, for
/// eight hours, which the gate accepts.
#[tokio::test]
async fn the_cookie_holds_an_eight_hour_owner_token() {
    let (g, _host_owner_token, _db) = spin_up();
    let res = sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await;
    let cookies = set_cookie_values(&res);
    let owner_token = owner_browser_session_token(&res);
    assert_eq!(
        cookies,
        [format!(
            "__Host-owner_browser_session={owner_token}; Secure; HttpOnly; SameSite=Lax; Path=/; \
             Max-Age=28800"
        )]
    );

    let claims = claims_of(&owner_token);
    assert_eq!(claims["sub"], "wildflower-host");
    assert_eq!(claims["iss"], SERVER_ORIGIN);
    assert_eq!(claims["aud"], SERVER_ORIGIN);
    assert_eq!(
        claims["scope"],
        wildflowerhealthio_authorization_server::default_local_granted_scopes().join(" ")
    );
    assert_eq!(
        claims["exp"].as_i64().expect("exp") - claims["iat"].as_i64().expect("iat"),
        8 * 60 * 60
    );
    assert!(claims["jti"].as_str().is_some_and(|jti| !jti.is_empty()));

    assert_eq!(
        g.router
            .clone()
            .oneshot(owner_grants_probe(&owner_token))
            .await
            .expect("oneshot")
            .status(),
        StatusCode::OK
    );
}

/// Each sign-in mints a token of its own, which can be revoked by its `jti`
/// alone: `GET /authorization/session` answers as the Owner, and once the
/// `jti` is revoked, `401`, while another sign-in's token still works.
#[tokio::test]
async fn an_owner_browser_session_is_revoked_by_its_jti() {
    let (g, host_owner_token, _db) = spin_up();
    let session = |token: String| {
        let router = g.router.clone();
        async move {
            router
                .oneshot(loopback_request(
                    Request::get("/authorization/session")
                        .header("authorization", format!("Bearer {token}")),
                    Body::empty(),
                ))
                .await
                .expect("oneshot")
        }
    };
    let first = owner_browser_session_token(
        &sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await,
    );
    let second = owner_browser_session_token(
        &sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await,
    );
    assert_ne!(jti_of(&first), jti_of(&second));

    let res = session(first.clone()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["scopes"],
        serde_json::json!(wildflowerhealthio_authorization_server::default_local_granted_scopes())
    );

    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &host_owner_token,
            serde_json::json!({
                "jti": jti_of(&first),
                "expiresAt": (Utc::now() + Duration::hours(8)).to_rfc3339(),
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    assert_eq!(session(first).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(session(second).await.status(), StatusCode::OK);
}
