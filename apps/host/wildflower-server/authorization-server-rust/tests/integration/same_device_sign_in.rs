//! Same-device sign-in, `GET /oauth/sign-in?code=…&next=…`: a code the base
//! minted in-process signs a browser in as the Owner, once, starting a
//! same-device browser session whose token, holding the Owner's scopes, it
//! hands the browser as its `__Host-browser_session` cookie, and sending it
//! on to an allowed `next`.

use crate::common::*;

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

/// A sign-in code signs a browser in once: the first use answers a `303`,
/// uncached, with the browser session cookie, and a second use gets the error
/// page.
#[tokio::test]
async fn a_code_signs_in_once() {
    let (g, _owner_token, _db) = spin_up();
    let code = g.same_device_sign_in_code_minter.mint();

    let signed_in = sign_in(&g, &code, "/").await;
    assert_eq!(signed_in.status(), StatusCode::SEE_OTHER);
    assert_cache_suppressed(&signed_in, "the sign-in");
    browser_session_token(&signed_in);

    assert_refused(sign_in(&g, &code, "/").await, "a spent code").await;
}

/// A code the base never minted, or no code at all, gets the error page: no
/// cookie and no redirect.
#[tokio::test]
async fn an_unknown_code_signs_nobody_in() {
    let (g, _owner_token, _db) = spin_up();
    let _outstanding = g.same_device_sign_in_code_minter.mint();
    assert_refused(sign_in(&g, "no-such-code", "/").await, "an unknown code").await;
    assert_refused(
        g.router
            .clone()
            .oneshot(build_request(Request::get("/oauth/sign-in"), Body::empty()))
            .await
            .expect("oneshot"),
        "no code",
    )
    .await;
}

/// After signing in, the browser is sent on to `next` when it is a path on
/// this server, or under the hosted launcher or Authorization app, or under
/// this server's own launcher or Authorization app as its host configures
/// them.
#[tokio::test]
async fn the_browser_goes_on_to_an_allowed_next() {
    let (g, _owner_token, _db) = spin_up();
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
        // This server's own launcher and Authorization app, as its host
        // configures them.
        (
            "https://apps.test/launcher?theme=dark&iss=https%3A%2F%2Fruth.relay.example&launch=n1",
            "https://apps.test/launcher?theme=dark&iss=https%3A%2F%2Fruth.relay.example&launch=n1",
        ),
        (
            "https://manage.test/authorization/?iss=https%3A%2F%2Fruth.relay.example",
            "https://manage.test/authorization/?iss=https%3A%2F%2Fruth.relay.example",
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

/// A `next` anywhere else (protocol-relative, another origin, outside the
/// allowed bases, the bare server origin, or empty) gets the error page and
/// leaves the code unspent, so it still signs in with an allowed `next`.
#[tokio::test]
async fn a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable() {
    let (g, _owner_token, _db) = spin_up();
    let code = g.same_device_sign_in_code_minter.mint();
    for next in [
        "//evil.example/",
        "/\\evil.example",
        "https://evil.example/",
        "https://launcher.test/elsewhere/",
        "https://apps.test/elsewhere",
        "https://manage.test/",
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

/// The cookie carries exactly the browser session cookie's attributes, and its
/// value is an Owner token: the browser-session client holding the Owner's
/// grant, for eight hours, which the gate accepts.
#[tokio::test]
async fn the_cookie_holds_an_eight_hour_owner_token() {
    let (g, _owner_token, _db) = spin_up();
    let res = sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await;
    let cookies = set_cookie_values(&res);
    let owner_token = browser_session_token(&res);
    assert_eq!(
        cookies,
        [format!(
            "__Host-browser_session={owner_token}; Secure; HttpOnly; SameSite=Lax; Path=/; \
             Max-Age=28800"
        )]
    );

    let claims = claims_of(&owner_token);
    assert_eq!(
        claims["sub"],
        wildflowerhealthio_authorization_server::BROWSER_SESSION_CLIENT_ID
    );
    assert_eq!(claims["iss"], SERVER_ORIGIN);
    assert_eq!(claims["aud"], SERVER_ORIGIN);
    assert_eq!(
        claims["scope"],
        wildflowerhealthio_authorization_server::owner_scopes().join(" ")
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
async fn a_browser_session_is_revoked_by_its_jti() {
    let (g, owner_token, _db) = spin_up();
    let session = |token: String| {
        let router = g.router.clone();
        async move {
            router
                .oneshot(build_request(
                    Request::get("/authorization/session")
                        .header("authorization", format!("Bearer {token}")),
                    Body::empty(),
                ))
                .await
                .expect("oneshot")
        }
    };
    let first =
        browser_session_token(&sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await);
    let second =
        browser_session_token(&sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await);
    assert_ne!(jti_of(&first), jti_of(&second));

    let res = session(first.clone()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["scopes"],
        serde_json::json!(wildflowerhealthio_authorization_server::owner_scopes())
    );

    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &owner_token,
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

/// Revoking the browser-session client's subject is a `204`
/// that signs every browser out at once, while a token issued to
/// another client keeps working. The epoch is second-granular, so a token
/// issued in the revoking second is revoked too.
#[tokio::test]
async fn revoking_the_browser_session_client_s_subject_signs_every_browser_out() {
    let (g, owner_token, _db) = spin_up();
    let first =
        browser_session_token(&sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await);
    let second =
        browser_session_token(&sign_in(&g, &g.same_device_sign_in_code_minter.mint(), "/").await);
    let grants_status = |token: String| {
        let router = g.router.clone();
        async move {
            router
                .oneshot(owner_grants_probe(&token))
                .await
                .expect("oneshot")
                .status()
        }
    };
    assert_eq!(grants_status(first.clone()).await, StatusCode::OK);

    // The epoch is second-granular: a token issued in the revoking second is
    // revoked too, so no wait is needed.
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &owner_token,
            serde_json::json!({
                "subject": wildflowerhealthio_authorization_server::BROWSER_SESSION_CLIENT_ID,
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    assert_eq!(grants_status(first).await, StatusCode::UNAUTHORIZED);
    assert_eq!(grants_status(second).await, StatusCode::UNAUTHORIZED);
    assert_eq!(
        grants_status(owner_token).await,
        StatusCode::OK,
        "another client's token is untouched"
    );
}

/// The browser-session client is essential, so the Owner can't disable it; one
/// disabled out of band (direct SQL) still signs nobody in. A sign-in then
/// renders the refusal page and sets no cookie, leaving the code unspent;
/// re-enabling the client lets the same code sign in.
#[tokio::test]
async fn a_disabled_browser_session_client_signs_nobody_in_until_re_enabled() {
    let (g, owner_token, db) = spin_up();
    let browser_session_client_id =
        wildflowerhealthio_authorization_server::BROWSER_SESSION_CLIENT_ID;
    let code = g.same_device_sign_in_code_minter.mint();

    assert!(store_handle(&db)
        .write(|tx| tx.set_client_disabled(browser_session_client_id, Some(Utc::now())))
        .expect("disable the client out of band"));
    let refused = sign_in(&g, &code, "/").await;
    assert_cache_suppressed(&refused, "the refusal");
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert!(set_cookie_values(&refused).is_empty(), "no cookie");
    assert!(
        body_string(refused.into_body())
            .await
            .contains("<h1>Browser sign-in disabled</h1>"),
        "the disabled-client refusal page"
    );

    assert_eq!(
        enable_client(&g, &owner_token, browser_session_client_id)
            .await
            .status(),
        StatusCode::OK
    );
    let signed_in = sign_in(&g, &code, "/").await;
    assert_eq!(signed_in.status(), StatusCode::SEE_OTHER);
    browser_session_token(&signed_in);
}
