//! Browser pairing: a browser that isn't the Owner's opens `/oauth/pair`,
//! whose page starts a pairing (`POST /oauth/pair/start`), shows its code, and
//! polls (`POST /oauth/pair/poll`). The Owner approves it at the device page
//! (`/authorization/devices/{userCode}`), and the poll that finds it approved
//! hands the browser an approved browser session as its cookie. The pages'
//! bearer comes from the host's cookie→bearer layer, so these tests send the
//! Owner's session token as the bearer themselves.

use wildflowerhealthio_authorization_server::BROWSER_SESSION_CLIENT_ID;

use crate::common::*;

/// A Firefox user agent on Linux, which names the browser "Firefox on Linux".
const FIREFOX_LINUX_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

/// Where the pairing page sends the browser once it holds its session.
const NEXT: &str = "/oauth/authorize?client_id=integration-test-app&state=s";

/// What `/oauth/pair/start` answered.
struct StartedPairing {
    pairing_code: String,
    user_code: String,
}

/// `POST` a JSON `body` to `path`, from the browser `user_agent` names.
async fn post_json(
    g: &AuthorizationServer,
    path: &str,
    bearer: Option<&str>,
    body: Value,
) -> axum::response::Response {
    let builder = Request::post(path)
        .header("content-type", "application/json")
        .header("user-agent", FIREFOX_LINUX_USER_AGENT);
    let builder = match bearer {
        Some(bearer) => builder.header("authorization", format!("Bearer {bearer}")),
        None => builder,
    };
    g.router
        .clone()
        .oneshot(build_request(builder, Body::from(body.to_string())))
        .await
        .expect("oneshot")
}

/// Start a pairing for `NEXT`, as the pairing page does on load.
async fn start_pairing(g: &AuthorizationServer) -> StartedPairing {
    let res = post_json(
        g,
        "/oauth/pair/start",
        None,
        serde_json::json!({ "next": NEXT }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the pairing start");
    let body = body_json(res.into_body()).await;
    assert_eq!(body["browserName"], "Firefox on Linux");
    assert_eq!(body["next"], NEXT);
    assert_eq!(body["expiresIn"], 300);
    assert_eq!(body["interval"], 5);
    StartedPairing {
        pairing_code: body["pairingCode"]
            .as_str()
            .expect("pairingCode")
            .to_owned(),
        user_code: body["userCode"].as_str().expect("userCode").to_owned(),
    }
}

/// The pairing page's poll for `pairing_code`.
async fn poll(
    g: &AuthorizationServer,
    pairing_code: &str,
    browser_name: &str,
) -> axum::response::Response {
    post_json(
        g,
        "/oauth/pair/poll",
        None,
        serde_json::json!({ "pairingCode": pairing_code, "browserName": browser_name }),
    )
    .await
}

/// The status a poll answered with, its cookies, and the response.
async fn poll_status(
    g: &AuthorizationServer,
    pairing_code: &str,
    browser_name: &str,
) -> (String, Vec<String>) {
    let res = poll(g, pairing_code, browser_name).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the pairing poll");
    let cookies = set_cookie_values(&res);
    let body = body_json(res.into_body()).await;
    (body["status"].as_str().expect("status").to_owned(), cookies)
}

/// The Owner's approval of the pairing `user_code` names, ticking
/// `approved_scopes`, on `approver_token`.
async fn approve(
    g: &AuthorizationServer,
    approver_token: &str,
    user_code: &str,
    approved_scopes: &[&str],
) -> axum::response::Response {
    post_json(
        g,
        &format!("/authorization/devices/{user_code}/approve"),
        Some(approver_token),
        serde_json::json!({ "approvedScopes": approved_scopes }),
    )
    .await
}

/// The approved session's token a poll's `Set-Cookie` carries, checked to
/// last a day.
fn approved_session_token(cookies: &[String]) -> String {
    let [cookie] = cookies else {
        panic!("exactly one cookie, got {cookies:?}");
    };
    let token = cookie
        .strip_prefix("__Host-browser_session=")
        .and_then(|rest| rest.split(';').next())
        .unwrap_or_else(|| panic!("the browser session cookie, got {cookie}"))
        .to_owned();
    assert_eq!(
        cookie,
        &format!(
            "__Host-browser_session={token}; Secure; HttpOnly; SameSite=Lax; Path=/; \
             Max-Age=86400"
        )
    );
    token
}

/// The whole pairing: the Owner is notified of a remote browser by name, sees
/// it on the device page with the Owner's scopes all ticked, unticks some,
/// and approves; the browser's next poll hands it a
/// 24 h approved session holding exactly the approved scopes, which the gates
/// accept and which writes no grant.
#[tokio::test]
async fn a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes() {
    let (g, _owner_token, db) = spin_up();
    let started = start_pairing(&g).await;
    assert_eq!(
        newest_pending_consent(&db),
        Some(NewestPendingConsent::BrowserPairing {
            user_code: started.user_code.clone(),
            browser_name: "Firefox on Linux".to_owned(),
        })
    );

    let (status, cookies) = poll_status(&g, &started.pairing_code, "Ruth's laptop").await;
    assert_eq!(status, "pending");
    assert!(cookies.is_empty(), "no cookie while pending");

    let owner_session_token = signed_in_owner_session_token(&g).await;
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get(format!("/authorization/devices/{}", started.user_code))
                .header("authorization", format!("Bearer {owner_session_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let card = body_json(res.into_body()).await;
    assert_eq!(card["kind"], "browser");
    assert_eq!(card["deviceName"], "Ruth's laptop", "the poll renamed it");
    assert_eq!(card["clientId"], BROWSER_SESSION_CLIENT_ID);
    assert_eq!(
        card["startingScopes"],
        serde_json::json!(wildflowerhealthio_authorization_server::owner_scopes()),
        "the Owner's card opens with everything ticked"
    );
    assert_eq!(
        card["allowedScopes"],
        serde_json::json!(wildflowerhealthio_authorization_server::owner_scopes())
    );

    let res = approve(
        &g,
        &owner_session_token,
        &started.user_code,
        &["wildflower/launch", "system/Patient.rs"],
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "approved");
    assert_eq!(newest_pending_consent(&db), None);

    let (status, cookies) = poll_status(&g, &started.pairing_code, "Ruth's laptop").await;
    assert_eq!(status, "approved");
    let session_token = approved_session_token(&cookies);
    let claims = decode_jwt_payload(&session_token);
    assert_eq!(claims["sub"], BROWSER_SESSION_CLIENT_ID);
    assert_eq!(claims["scope"], "wildflower/launch system/Patient.rs");
    assert_eq!(
        claims["exp"].as_i64().expect("exp") - claims["iat"].as_i64().expect("iat"),
        24 * 60 * 60
    );
    let sid = claims["sid"].as_str().expect("names its session");
    let session = store_handle(&db)
        .read(|tx| tx.browser_session_by_sid(sid))
        .expect("read")
        .expect("the approved session is stored");
    assert_eq!(session.kind.as_ref(), "approved");
    assert_eq!(session.name.as_deref(), Some("Ruth's laptop"));
    assert_eq!(session.scopes, ["wildflower/launch", "system/Patient.rs"]);
    assert_eq!(session.expires_at - session.created_at, Duration::hours(24));

    // The gates accept the session's token, with exactly its scopes.
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get("/authorization/session")
                .header("authorization", format!("Bearer {session_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["scopes"],
        serde_json::json!(["wildflower/launch", "system/Patient.rs"])
    );

    // Pairing recorded no grant.
    assert!(store_handle(&db)
        .read(|tx| tx.all_grants())
        .expect("grants")
        .is_empty());

    // The pairing starts one session: the next poll finds it spent.
    let (status, cookies) = poll_status(&g, &started.pairing_code, "").await;
    assert_eq!(status, "expired");
    assert!(cookies.is_empty());
}

/// The Owner's ticks are clamped to the Owner's scopes, and an approver can
/// delegate no resource scope it doesn't hold.
#[tokio::test]
async fn an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s() {
    let (g, _owner_token, db) = spin_up();
    let owner_session_token = signed_in_owner_session_token(&g).await;

    let started = start_pairing(&g).await;
    let res = approve(
        &g,
        &owner_session_token,
        &started.user_code,
        &["wildflower/launch", "openid", "offline_access"],
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let (status, cookies) = poll_status(&g, &started.pairing_code, "").await;
    assert_eq!(status, "approved");
    assert_eq!(
        decode_jwt_payload(&approved_session_token(&cookies))["scope"],
        "wildflower/launch",
        "ticks past the Owner's scopes are dropped"
    );

    let narrow_approver = mint_browser_session_token(
        &db,
        decode_jwt_payload(&owner_session_token)["sid"]
            .as_str()
            .expect("sid"),
        &[
            "wildflower/AuthorizationRequest.r",
            "wildflower/AuthorizationRequest.u",
        ],
    );
    let started = start_pairing(&g).await;
    let res = approve(
        &g,
        &narrow_approver,
        &started.user_code,
        &["system/*.cruds"],
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let (status, _) = poll_status(&g, &started.pairing_code, "").await;
    assert_eq!(status, "pending", "the refused approval left it pending");
}

/// An approver holding less than the Owner opens the card with everything it
/// may delegate ticked, not the Owner's scopes, so approving it as it opened
/// starts the session. An approver without `wildflower/launch` can't hand the
/// browser launch: it isn't ticked, and ticking it is refused.
#[tokio::test]
async fn a_narrower_approver_s_card_opens_with_what_it_may_delegate() {
    let (g, _owner_token, db) = spin_up();
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let narrow_approver = mint_browser_session_token(
        &db,
        decode_jwt_payload(&owner_session_token)["sid"]
            .as_str()
            .expect("sid"),
        &[
            "wildflower/AuthorizationRequest.r",
            "wildflower/AuthorizationRequest.u",
            "system/Patient.rs",
            "openid",
        ],
    );
    let started = start_pairing(&g).await;
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get(format!("/authorization/devices/{}", started.user_code))
                .header("authorization", format!("Bearer {narrow_approver}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let card = body_json(res.into_body()).await;
    let ticks = serde_json::json!([
        "wildflower/AuthorizationRequest.r",
        "wildflower/AuthorizationRequest.u",
        "system/Patient.rs",
    ]);
    assert_eq!(card["startingScopes"], ticks);
    assert!(card["allowedScopes"]
        .as_array()
        .expect("an array")
        .contains(&serde_json::json!("wildflower/launch")));

    let ticks: Vec<&str> = ticks
        .as_array()
        .expect("an array")
        .iter()
        .map(|tick| tick.as_str().expect("a scope"))
        .collect();
    let with_launch: Vec<&str> = ["wildflower/launch"]
        .into_iter()
        .chain(ticks.clone())
        .collect();
    let res = approve(&g, &narrow_approver, &started.user_code, &with_launch).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = approve(&g, &narrow_approver, &started.user_code, &ticks).await;
    assert_eq!(res.status(), StatusCode::OK);
    let (status, cookies) = poll_status(&g, &started.pairing_code, "").await;
    assert_eq!(status, "approved");
    assert_eq!(
        decode_jwt_payload(&approved_session_token(&cookies))["scope"],
        "wildflower/AuthorizationRequest.r wildflower/AuthorizationRequest.u system/Patient.rs"
    );
}

/// A declined pairing tells the page so and sets no cookie.
#[tokio::test]
async fn a_declined_pairing_sets_no_cookie() {
    let (g, _owner_token, _db) = spin_up();
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let started = start_pairing(&g).await;
    let res = post_json(
        &g,
        &format!("/authorization/devices/{}/deny", started.user_code),
        Some(&owner_session_token),
        serde_json::json!({}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let (status, cookies) = poll_status(&g, &started.pairing_code, "").await;
    assert_eq!(status, "denied");
    assert!(cookies.is_empty());
}

/// A `next` off the server's origin starts nothing, and a poll by an unknown
/// pairing code, or by a user code, finds nothing.
#[tokio::test]
async fn a_foreign_next_or_an_unknown_code_starts_and_finds_nothing() {
    let (g, _owner_token, db) = spin_up();
    for next in [
        "https://evil.example/oauth/authorize",
        "//evil.example/oauth/authorize",
        "/\\evil.example",
        "https://launcher.test/launcher/",
    ] {
        let res = post_json(
            &g,
            "/oauth/pair/start",
            None,
            serde_json::json!({ "next": next }),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{next}");
        assert_eq!(
            body_json(res.into_body()).await["error"],
            "BrowserPairingNextNotAllowed"
        );
    }
    assert_eq!(newest_pending_consent(&db), None);

    let started = start_pairing(&g).await;
    for presented in ["no-such-code", started.user_code.as_str()] {
        let res = poll(&g, presented, "").await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{presented}");
        assert_eq!(
            body_json(res.into_body()).await["error"],
            "BrowserPairingNotFound"
        );
    }
}

/// `/oauth/token` mints no browser session token: the browser-session client
/// may use no grant, and a pairing code is no `device_code`, before or after
/// the Owner approves.
#[tokio::test]
async fn the_token_endpoint_cannot_mint_a_browser_token() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let started = start_pairing(&g).await;
    let device_code_poll = |client_id: &str| {
        format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
             client_id={client_id}&device_code={}",
            started.pairing_code
        )
    };
    let token_request = |body: String| {
        g.router.clone().oneshot(build_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body),
        ))
    };
    for approved in [false, true] {
        if approved {
            let res = approve(
                &g,
                &owner_session_token,
                &started.user_code,
                &["wildflower/launch"],
            )
            .await;
            assert_eq!(res.status(), StatusCode::OK);
        }
        let res = token_request(device_code_poll(BROWSER_SESSION_CLIENT_ID))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "approved: {approved}"
        );
        assert_eq!(
            body_json(res.into_body()).await["error"],
            "unauthorized_client",
            "approved: {approved}"
        );
        let res = token_request(device_code_poll(TEST_CLIENT_ID))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "approved: {approved}"
        );
        assert_eq!(
            body_json(res.into_body()).await["error"],
            "invalid_grant",
            "approved: {approved}"
        );
    }
    let (status, _) = poll_status(&g, &started.pairing_code, "").await;
    assert_eq!(status, "approved", "the token endpoint claimed nothing");
}
