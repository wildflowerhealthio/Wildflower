//! Browser sessions: a same-device sign-in starts a same-device session row,
//! every token, code and refresh family minted under it names it as `sid`,
//! and revoking the row ends them on the `/authorization` surface, at the
//! in-process FHIR verifier and at refresh. `/authorization/browser-sessions`
//! lists the live rows and revokes one, and `/oauth/sign-out` revokes the
//! session a browser's cookie holds.

use crate::common::*;
use wildflowerhealthio_authorization_server::domain::access_token::AccessTokenVerifyError;
use wildflowerhealthio_authorization_server::domain::browser_session::BrowserSessionKind;

/// The `sid` claim of `token`, unverified.
fn sid_of(token: &str) -> String {
    decode_jwt_payload(token)["sid"]
        .as_str()
        .expect("the token names its browser session")
        .to_owned()
}

/// `POST /oauth/token` with `form`.
async fn post_token(g: &AuthorizationServer, form: String) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(form),
        ))
        .await
        .expect("oneshot")
}

/// A sign-in starts a same-device session that lasts the eight hours its token
/// does, unnamed and holding the Owner's scopes, and the token names it. A
/// second sign-in gets a different `sid`.
#[tokio::test]
async fn a_sign_in_starts_a_same_device_session_its_token_names() {
    let (g, _owner_token, db) = spin_up();
    let same_device_session_token = signed_in_same_device_session_token(&g).await;
    let sid = sid_of(&same_device_session_token);

    let session = store_handle(&db)
        .read(|tx| tx.browser_session_by_sid(&sid))
        .expect("read")
        .expect("the sign-in stored its session");
    assert_eq!(session.kind, BrowserSessionKind::SameDevice);
    assert_eq!(session.name, None);
    assert_eq!(
        session.scopes,
        wildflowerhealthio_authorization_server::owner_scopes()
    );
    assert_eq!(session.expires_at - session.created_at, Duration::hours(8));
    assert_eq!(session.revoked_at, None);
    let token_expires_at = decode_jwt_payload(&same_device_session_token)["exp"]
        .as_i64()
        .expect("exp");
    assert!(
        (token_expires_at - session.expires_at.timestamp()).abs() <= 1,
        "the token ends with its session"
    );

    let other = signed_in_same_device_session_token(&g).await;
    assert_ne!(sid_of(&other), sid, "each sign-in starts its own session");
}

/// Revoking a session stops its token at the `/authorization` gate and at the
/// in-process verifier the FHIR server checks bearers with, while another
/// session's token keeps working on both.
#[tokio::test]
async fn revoking_a_session_stops_its_authorization_and_fhir_requests() {
    let (g, _owner_token, db) = spin_up();
    let revoked = signed_in_same_device_session_token(&g).await;
    let standing = signed_in_same_device_session_token(&g).await;
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
    assert_eq!(grants_status(revoked.clone()).await, StatusCode::OK);
    assert!(g.in_process_token_verifier.verify(&revoked).is_ok());

    assert!(store_handle(&db)
        .write(|tx| tx.revoke_browser_session(&sid_of(&revoked), Utc::now()))
        .expect("revoke"));

    assert_eq!(
        grants_status(revoked.clone()).await,
        StatusCode::UNAUTHORIZED
    );
    assert!(matches!(
        g.in_process_token_verifier.verify(&revoked),
        Err(AccessTokenVerifyError::Revoked)
    ));
    assert_eq!(grants_status(standing.clone()).await, StatusCode::OK);
    assert!(g.in_process_token_verifier.verify(&standing).is_ok());
}

/// An app authorized from a browser signed in as the Owner is issued its code,
/// tokens and refresh family under that browser's session: they all name its
/// `sid`, its refresh marks the session seen, and once the session is revoked the
/// family can't be refreshed and the app's access token is refused.
#[tokio::test]
async fn an_app_authorized_in_a_session_is_ended_with_it() {
    let (g, owner_token, db) = spin_up();
    let same_device_session_token = signed_in_same_device_session_token(&g).await;
    let sid = sid_of(&same_device_session_token);

    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get(format!(
                "/oauth/authorize?{}",
                authorize_query("brand-new-app", "read%20offline_access")
            ))
            .header(
                "cookie",
                format!("__Host-browser_session={same_device_session_token}"),
            ),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let consent_card = location_of(&res);
    let request_id = consent_card
        .strip_prefix("authorize/")
        .and_then(|rest| rest.strip_suffix("/consent"))
        .unwrap_or_else(|| panic!("a consent-card redirect, got {consent_card}"))
        .to_owned();

    let res = approve_oauth_consent(
        &g,
        &owner_token,
        &request_id,
        r#"{"approvedScopes":["read","offline_access"],"acknowledgedRegistrationChange":true}"#
            .to_string(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let redirect = Url::parse(
        body_json(res.into_body()).await["redirect"]
            .as_str()
            .expect("approve redirect"),
    )
    .expect("redirect URL");
    let code = redirect
        .query_pairs()
        .find(|(name, _)| name == "code")
        .map(|(_, code)| code.into_owned())
        .expect("a code");

    let res = post_token(
        &g,
        format!(
            "grant_type=authorization_code&client_id=brand-new-app&code={code}&\
             code_verifier={CODE_VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let issued = body_json(res.into_body()).await;
    let access_token = issued["access_token"].as_str().expect("access token");
    assert_eq!(sid_of(access_token), sid);
    let refresh_token = issued["refresh_token"]
        .as_str()
        .expect("offline_access earns a refresh token");

    let refresh = |refresh_token: String| {
        post_token(
            &g,
            format!(
                "grant_type=refresh_token&client_id=brand-new-app&refresh_token={refresh_token}"
            ),
        )
    };
    let refreshed_at = Utc::now();
    let res = refresh(refresh_token.to_owned()).await;
    assert_eq!(res.status(), StatusCode::OK);
    let refreshed = body_json(res.into_body()).await;
    let last_seen_at = store_handle(&db)
        .read(|tx| tx.browser_session_by_sid(&sid))
        .expect("read")
        .expect("stored")
        .last_seen_at;
    assert!(
        last_seen_at >= refreshed_at,
        "the app refreshing marks the session seen, at {last_seen_at}"
    );
    assert_eq!(
        sid_of(refreshed["access_token"].as_str().expect("access token")),
        sid,
        "a refreshed token names the family's session"
    );
    let successor = refreshed["refresh_token"]
        .as_str()
        .expect("a successor")
        .to_owned();

    assert!(store_handle(&db)
        .write(|tx| tx.revoke_browser_session(&sid, Utc::now()))
        .expect("revoke"));

    let res = refresh(successor).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has been revoked",
        })
    );
    assert!(matches!(
        g.in_process_token_verifier.verify(access_token),
        Err(AccessTokenVerifyError::Revoked)
    ));
}

/// A request made in a browser session that is revoked before the Owner
/// approves it is denied instead: the approval sends the app `access_denied`,
/// not a code whose tokens would be refused.
#[tokio::test]
async fn approving_a_request_whose_session_was_revoked_denies_it() {
    let (g, owner_token, db) = spin_up();
    let same_device_session_token = signed_in_same_device_session_token(&g).await;

    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get(format!(
                "/oauth/authorize?{}",
                authorize_query("brand-new-app", "read")
            ))
            .header(
                "cookie",
                format!("__Host-browser_session={same_device_session_token}"),
            ),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let consent_card = location_of(&res);
    let request_id = consent_card
        .strip_prefix("authorize/")
        .and_then(|rest| rest.strip_suffix("/consent"))
        .unwrap_or_else(|| panic!("a consent-card redirect, got {consent_card}"))
        .to_owned();

    assert!(store_handle(&db)
        .write(|tx| tx.revoke_browser_session(&sid_of(&same_device_session_token), Utc::now()))
        .expect("revoke"));

    let res = approve_oauth_consent(
        &g,
        &owner_token,
        &request_id,
        r#"{"approvedScopes":["read"],"acknowledgedRegistrationChange":true}"#.to_string(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let decision = body_json(res.into_body()).await;
    assert_eq!(decision["status"], "denied");
    let redirect =
        Url::parse(decision["redirect"].as_str().expect("a redirect")).expect("redirect URL");
    let query: Vec<(String, String)> = redirect.query_pairs().into_owned().collect();
    assert!(query.contains(&("error".to_owned(), "access_denied".to_owned())));
    assert!(query.contains(&(
        "error_description".to_owned(),
        "This browser was signed out before the sign-in finished.".to_owned()
    )));
    assert!(query.iter().all(|(name, _)| name != "code"));
}

/// `method path` on the `/authorization` surface, with `token` as its bearer.
async fn authorization_request(
    g: &AuthorizationServer,
    method: &str,
    path: &str,
    token: &str,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// The `sid`s `GET /authorization/browser-sessions` lists to `token`, each
/// with whether it is the caller's.
async fn listed_browser_sessions(g: &AuthorizationServer, token: &str) -> Vec<(String, bool)> {
    let res = authorization_request(g, "GET", "/authorization/browser-sessions", token).await;
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body())
        .await
        .as_array()
        .expect("a list")
        .iter()
        .map(|session| {
            (
                session["sid"].as_str().expect("a sid").to_owned(),
                session["heldByCaller"].as_bool().expect("a flag"),
            )
        })
        .collect()
}

/// The list holds the live sessions, newest first, each row carrying the
/// session's columns and the caller's marked. Revoking one through the API
/// takes it off the list and ends its token; revoking it again is a `404`. A
/// fresh session's `lastSeenAt` equals its `createdAt`.
#[tokio::test]
async fn the_browsers_list_shows_live_sessions_and_revokes_one() {
    let (g, _owner_token, db) = spin_up();
    let caller = signed_in_same_device_session_token(&g).await;
    let other = signed_in_same_device_session_token(&g).await;
    let (caller_sid, other_sid) = (sid_of(&caller), sid_of(&other));

    let res = authorization_request(&g, "GET", "/authorization/browser-sessions", &caller).await;
    assert_eq!(res.status(), StatusCode::OK);
    let rows = body_json(res.into_body()).await;
    let caller_row = rows
        .as_array()
        .expect("a list")
        .iter()
        .find(|row| row["sid"] == caller_sid.as_str())
        .expect("the caller's session is listed");
    assert_eq!(caller_row["kind"], "same_device");
    assert_eq!(caller_row["name"], Value::Null);
    assert_eq!(caller_row["heldByCaller"], true);
    assert_eq!(
        caller_row["lastSeenAt"], caller_row["createdAt"],
        "signing in is the session's first use"
    );
    for column in ["createdAt", "expiresAt"] {
        assert!(caller_row[column].is_string(), "{column}");
    }
    assert_eq!(
        listed_browser_sessions(&g, &caller).await,
        vec![
            (other_sid.clone(), false),
            (caller_sid.clone(), true),
            (db.paired_browser_sid.clone(), false),
        ]
    );

    let path = format!("/authorization/browser-sessions/{other_sid}");
    let res = authorization_request(&g, "DELETE", &path, &caller).await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        listed_browser_sessions(&g, &caller).await,
        vec![
            (caller_sid.clone(), true),
            (db.paired_browser_sid.clone(), false),
        ]
    );
    assert_eq!(
        g.router
            .clone()
            .oneshot(owner_grants_probe(&other))
            .await
            .expect("oneshot")
            .status(),
        StatusCode::UNAUTHORIZED,
        "the revoked session's token is ended"
    );

    let res = authorization_request(&g, "DELETE", &path, &caller).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "error": "BrowserSessionNotFound", "sid": other_sid })
    );
}

/// A browser may revoke its own session, which signs it out: its next
/// request is refused.
#[tokio::test]
async fn revoking_the_caller_s_own_session_signs_it_out() {
    let (g, _owner_token, _db) = spin_up();
    let caller = signed_in_same_device_session_token(&g).await;
    let path = format!("/authorization/browser-sessions/{}", sid_of(&caller));

    let res = authorization_request(&g, "DELETE", &path, &caller).await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let res = authorization_request(&g, "GET", "/authorization/browser-sessions", &caller).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// Listing takes `wildflower/BrowserSession.r` and revoking
/// `wildflower/BrowserSession.d`: a token without them gets the `403` naming
/// the missing scope, and nothing is revoked.
#[tokio::test]
async fn the_browsers_routes_are_scope_gated() {
    let (g, _owner_token, db) = spin_up();
    let session_token = signed_in_same_device_session_token(&g).await;
    let reader = mint_scoped_token(&db, &["wildflower/BrowserSession.r"]);

    let res = authorization_request(
        &g,
        "GET",
        "/authorization/browser-sessions",
        &mint_scoped_token(&db, &["wildflower/Grant.r"]),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["wildflower/BrowserSession.r"])
    );

    let path = format!("/authorization/browser-sessions/{}", sid_of(&session_token));
    let res = authorization_request(&g, "DELETE", &path, &reader).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["wildflower/BrowserSession.d"])
    );
    assert_eq!(
        listed_browser_sessions(&g, &reader)
            .await
            .into_iter()
            .map(|(sid, _)| sid)
            .collect::<Vec<_>>(),
        vec![sid_of(&session_token), db.paired_browser_sid.clone()],
        "the session stands"
    );
}

/// `POST /oauth/sign-out` with `cookie`, if any, as the pages' Sign out form
/// sends it.
async fn sign_out(g: &AuthorizationServer, cookie: Option<String>) -> axum::response::Response {
    let mut request = Request::post("/oauth/sign-out").header("origin", SERVER_ORIGIN);
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    g.router
        .clone()
        .oneshot(build_request(request, Body::empty()))
        .await
        .expect("oneshot")
}

/// Signing out revokes the session the cookie holds, so its token is refused
/// from then on, clears the cookie with the attributes it was set with, and
/// `303`s to the launcher's root. Another browser's session stands.
#[tokio::test]
async fn signing_out_revokes_the_cookie_s_session_and_clears_it() {
    let (g, _owner_token, db) = spin_up();
    let signing_out = signed_in_same_device_session_token(&g).await;
    let other = signed_in_same_device_session_token(&g).await;

    let res = sign_out(&g, Some(format!("__Host-browser_session={signing_out}"))).await;

    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(location_of(&res), LAUNCHER_BASE);
    assert_eq!(
        set_cookie_values(&res),
        vec!["__Host-browser_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"]
    );
    assert_cache_suppressed(&res, "the sign-out");
    let store = store_handle(&db);
    assert!(store
        .read(|tx| tx.is_browser_session_revoked(&sid_of(&signing_out)))
        .expect("read"));
    assert!(!store
        .read(|tx| tx.is_browser_session_revoked(&sid_of(&other)))
        .expect("read"));
    assert!(matches!(
        g.in_process_token_verifier.verify(&signing_out),
        Err(AccessTokenVerifyError::Revoked)
    ));
}

/// A browser with no cookie, or one whose session has already ended, has
/// nothing to revoke, and is still sent on signed out with its cookie cleared.
#[tokio::test]
async fn signing_out_without_a_standing_session_still_clears_the_cookie() {
    let (g, _owner_token, _db) = spin_up();
    let ended = signed_in_same_device_session_token(&g).await;
    let res = sign_out(&g, Some(format!("__Host-browser_session={ended}"))).await;
    assert_eq!(res.status(), StatusCode::SEE_OTHER);

    for cookie in [
        None,
        Some(format!("__Host-browser_session={ended}")),
        Some("__Host-browser_session=not-a-token".to_owned()),
    ] {
        let res = sign_out(&g, cookie.clone()).await;
        assert_eq!(res.status(), StatusCode::SEE_OTHER, "{cookie:?}");
        assert_eq!(location_of(&res), LAUNCHER_BASE, "{cookie:?}");
        assert_eq!(
            set_cookie_values(&res),
            vec!["__Host-browser_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"],
            "{cookie:?}"
        );
    }
}

/// `GET /authorization/session` on a browser session's token answers the
/// session's expiry, which the server's pages show as "Signed in until"; a
/// token under no browser session answers `null`.
#[tokio::test]
async fn the_session_read_answers_the_browser_session_s_expiry() {
    let (g, _owner_token, db) = spin_up();
    let session_token = signed_in_same_device_session_token(&g).await;
    let session = store_handle(&db)
        .read(|tx| tx.browser_session_by_sid(&sid_of(&session_token)))
        .expect("read")
        .expect("stored");

    let res = authorization_request(&g, "GET", "/authorization/session", &session_token).await;
    assert_eq!(res.status(), StatusCode::OK);
    let expires_at = body_json(res.into_body()).await["browserSessionExpiresAt"]
        .as_str()
        .expect("an expiry")
        .parse::<chrono::DateTime<Utc>>()
        .expect("an RFC 3339 time");
    assert_eq!(expires_at, session.expires_at);

    let res = authorization_request(
        &g,
        "GET",
        "/authorization/session",
        &mint_scoped_token(&db, &["wildflower/Grant.r"]),
    )
    .await;
    assert_eq!(
        body_json(res.into_body()).await["browserSessionExpiresAt"],
        Value::Null
    );
}
