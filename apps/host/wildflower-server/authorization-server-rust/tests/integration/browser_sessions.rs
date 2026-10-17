use crate::common::*;
use wildflowerhealthio_authorization_server::domain::browser_session::BrowserSessionKind;
use wildflowerhealthio_authorization_server::domain::token::VerifyError;

// Browser sessions: a same-device sign-in starts an Owner session row, every
// token, code and refresh family minted under it names it as `sid`, and
// revoking the row (through the store; there is no HTTP surface for it yet)
// ends them on the `/authorization` surface, the in-process FHIR verifier and
// at refresh.

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

/// A sign-in starts an Owner session that lasts the eight hours its token
/// does, unnamed and holding the Owner's scopes, and the token names it.
#[tokio::test]
async fn a_sign_in_starts_an_owner_session_its_token_names() {
    let (g, _owner_token, db) = spin_up();
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let sid = sid_of(&owner_session_token);

    let session = store_handle(&db)
        .browser_session_by_sid(&sid)
        .expect("read")
        .expect("the sign-in stored its session");
    assert_eq!(session.kind, BrowserSessionKind::Owner);
    assert_eq!(session.name, None);
    assert_eq!(
        session.scopes,
        wildflowerhealthio_authorization_server::owner_scopes()
    );
    assert_eq!(session.expires_at - session.created_at, Duration::hours(8));
    assert_eq!(session.revoked_at, None);
    let token_expires_at = decode_jwt_payload(&owner_session_token)["exp"]
        .as_i64()
        .expect("exp");
    assert!(
        (token_expires_at - session.expires_at.timestamp()).abs() <= 1,
        "the token ends with its session"
    );

    let other = signed_in_owner_session_token(&g).await;
    assert_ne!(sid_of(&other), sid, "each sign-in starts its own session");
}

/// Revoking a session stops its token at the `/authorization` gate and at the
/// in-process verifier the FHIR server checks bearers with, while another
/// session's token keeps working on both.
#[tokio::test]
async fn revoking_a_session_stops_its_authorization_and_fhir_requests() {
    let (g, _owner_token, db) = spin_up();
    let revoked = signed_in_owner_session_token(&g).await;
    let standing = signed_in_owner_session_token(&g).await;
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
        .revoke_browser_session(&sid_of(&revoked), Utc::now())
        .expect("revoke"));

    assert_eq!(
        grants_status(revoked.clone()).await,
        StatusCode::UNAUTHORIZED
    );
    assert!(matches!(
        g.in_process_token_verifier.verify(&revoked),
        Err(VerifyError::Revoked)
    ));
    assert_eq!(grants_status(standing.clone()).await, StatusCode::OK);
    assert!(g.in_process_token_verifier.verify(&standing).is_ok());
}

/// An app authorized from a browser signed in as the Owner is issued its code,
/// tokens and refresh family under that browser's session: they all name its
/// `sid`, its refresh marks the session seen, and once the session is revoked the family can't be refreshed and
/// the app's access token is refused.
#[tokio::test]
async fn an_app_authorized_in_a_session_is_ended_with_it() {
    let (g, owner_token, db) = spin_up();
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let sid = sid_of(&owner_session_token);

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
                format!("__Host-browser_session={owner_session_token}"),
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
        r#"{"approvedScopes":["read","offline_access"],"acknowledgedRegistration":true}"#
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
        .browser_session_by_sid(&sid)
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
        .revoke_browser_session(&sid, Utc::now())
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
        Err(VerifyError::Revoked)
    ));
}

/// A request made in a browser session that is revoked before the Owner
/// approves it is denied instead: the approval sends the app `access_denied`,
/// not a code whose tokens would be refused.
#[tokio::test]
async fn approving_a_request_whose_session_was_revoked_denies_it() {
    let (g, owner_token, db) = spin_up();
    let owner_session_token = signed_in_owner_session_token(&g).await;

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
                format!("__Host-browser_session={owner_session_token}"),
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
        .revoke_browser_session(&sid_of(&owner_session_token), Utc::now())
        .expect("revoke"));

    let res = approve_oauth_consent(
        &g,
        &owner_token,
        &request_id,
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":true}"#.to_string(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let decision = body_json(res.into_body()).await;
    assert_eq!(decision["status"], "denied");
    let redirect =
        Url::parse(decision["redirect"].as_str().expect("a redirect")).expect("redirect URL");
    let query: Vec<(String, String)> = redirect.query_pairs().into_owned().collect();
    assert!(query.contains(&("error".to_owned(), "access_denied".to_owned())));
    assert!(query.iter().all(|(name, _)| name != "code"));
}
