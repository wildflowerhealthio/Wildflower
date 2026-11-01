//! A browser whose session holds less than an app asks for can ask the Owner,
//! from the limited page, to widen its session (#1317): `…/ask-to-widen` files
//! a session widening for exactly what the session lacks, the Owner decides it
//! on its own card (`/authorization/session-widenings/{id}`, untick only),
//! and the limited page's poll (`/oauth/session-widenings/{id}/poll`) then
//! collects a wider token for the same session. The app's next sign-in with
//! `prompt=consent` brings the limited page back even after a remembered
//! Continue, so the browser can ask.

use crate::common::*;

/// `test-app`'s query for `patient/Patient.rs patient/Observation.rs
/// offline_access`, with `prompt=consent`.
fn app_query_prompting_consent() -> String {
    format!(
        "{}&prompt=consent",
        authorize_query(
            "test-app",
            "patient%2FPatient.rs%20patient%2FObservation.rs%20offline_access",
        )
    )
}

/// Register `test-app` for the query's scopes.
fn seed_app(db: &TestDb) {
    seed_client_with_redirect(
        db,
        "test-app",
        "https://app.example/cb",
        &[
            "patient/Patient.rs",
            "patient/Observation.rs",
            "offline_access",
        ],
    );
}

/// A browser paired with `wildflower/launch` and `patient/Patient.rs` alone,
/// which falls short of the query by `patient/Observation.rs`.
fn limited_browser(db: &TestDb) -> (String, String) {
    paired_browser_session_holding(db, &["wildflower/launch", "patient/Patient.rs"])
}

/// `POST {path}` from the browser holding `session_token`.
async fn post_with_session(
    g: &AuthorizationServer,
    session_token: &str,
    path: &str,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::post(path).header("cookie", browser_session_cookie(session_token)),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// `method {path}` on the Owner's `/authorization` surface, with `body`.
async fn as_owner(
    g: &AuthorizationServer,
    owner_token: &str,
    method: &str,
    path: &str,
    body: &str,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json"),
            Body::from(body.to_owned()),
        ))
        .await
        .expect("oneshot")
}

/// Ask to widen the session behind `session_token` from the limited page of
/// `request_id`, returning the widening's id.
async fn ask_to_widen(g: &AuthorizationServer, session_token: &str, request_id: &str) -> String {
    let res = post_with_session(
        g,
        session_token,
        &format!("/oauth/authorize/{request_id}/ask-to-widen"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the ask");
    body_json(res.into_body()).await["wideningId"]
        .as_str()
        .expect("a widening id")
        .to_owned()
}

/// The session token a `Set-Cookie` in `res` hands the browser.
fn session_token_set_by(res: &axum::response::Response) -> String {
    let prefix = format!(
        "{}=",
        wildflowerhealthio_authorization_server::BROWSER_SESSION_COOKIE
    );
    set_cookie_values(res)
        .iter()
        .find_map(|cookie| cookie.strip_prefix(&prefix))
        .and_then(|rest| rest.split(';').next())
        .expect("a session cookie")
        .to_owned()
}

/// The whole round: a session that went on past the limited page for the
/// app comes back to it with `prompt=consent`, asks the Owner, who unticks
/// nothing it wasn't asked and approves; the poll collects a wider token for
/// the same session, and the narrow one keeps working only for a grace;
/// going on then earns a code carrying what the session lacked.
#[tokio::test]
async fn an_approved_widening_lets_the_next_code_carry_what_the_session_lacked() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    let (sid, narrow_token) = limited_browser(&db);
    let first_request_id = limited_request_id(
        &get_authorize(&g.router, &narrow_token, &app_query_prompting_consent()).await,
    );
    continue_past_session_shortfall(&g.router, &narrow_token, &first_request_id).await;

    let request_id = limited_request_id(
        &get_authorize(&g.router, &narrow_token, &app_query_prompting_consent()).await,
    );
    let widening_id = ask_to_widen(&g, &narrow_token, &request_id).await;
    assert_eq!(
        owner_prompt(&db),
        Some(OwnerPrompt::SessionWidening {
            id: widening_id.clone(),
            browser_name: "Firefox on Linux".to_owned(),
        })
    );

    let res = as_owner(
        &g,
        &owner_token,
        "GET",
        &format!("/authorization/session-widenings/{widening_id}"),
        "",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "id": widening_id,
            "browserName": "Firefox on Linux",
            "clientId": "test-app",
            "clientName": "Integration Test Client",
            "requestedScopes": ["patient/Observation.rs"],
            "startingScopes": ["patient/Observation.rs"],
            "missingApprovalScopes": [],
        })
    );
    let poll_path = format!("/oauth/session-widenings/{widening_id}/poll");
    let res = post_with_session(&g, &narrow_token, &poll_path).await;
    assert_eq!(body_json(res.into_body()).await["status"], "pending");

    let res = as_owner(
        &g,
        &owner_token,
        "POST",
        &format!("/authorization/session-widenings/{widening_id}/approve"),
        r#"{"approvedScopes":["patient/Observation.rs","system/*.cruds"]}"#,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );
    assert!(
        matches!(
            owner_prompt(&db),
            Some(OwnerPrompt::AuthorizationCode { ref id, .. }) if *id == first_request_id
        ),
        "the widening is decided, and the first request still waits"
    );

    let res = post_with_session(&g, &narrow_token, &poll_path).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the poll");
    let wide_token = session_token_set_by(&res);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "widened" })
    );
    let wide_claims = decode_jwt_payload(&wide_token);
    assert_eq!(wide_claims["sid"], sid.as_str(), "the same session");
    assert_eq!(
        wide_claims["scope"],
        "wildflower/launch patient/Patient.rs patient/Observation.rs"
    );
    let res = post_with_session(&g, &narrow_token, &poll_path).await;
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "the narrow token keeps working for a grace, so a request already in flight with it lands"
    );
    assert!(
        set_cookie_values(&res).is_empty(),
        "and sets no cookie over the wide one"
    );
    assert_eq!(body_json(res.into_body()).await["status"], "expired");
    let res = post_with_session(&g, &wide_token, &poll_path).await;
    assert_eq!(body_json(res.into_body()).await["status"], "expired");

    let callback = continue_past_session_shortfall(&g.router, &wide_token, &request_id).await;
    assert_eq!(callback, format!("/oauth/authorize/{request_id}/wait"));
    let res = as_owner(
        &g,
        &owner_token,
        "POST",
        &format!("/authorization/oauth-consents/{request_id}/approve"),
        r#"{"approvedScopes":["patient/Patient.rs","patient/Observation.rs","offline_access"],"acknowledgedRegistrationChange":true}"#,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let code = store_handle(&db)
        .read(|tx| tx.authorization_code_by_request_id(&request_id))
        .expect("read")
        .expect("a code");
    assert_eq!(
        code.granted_scopes,
        [
            "patient/Patient.rs",
            "patient/Observation.rs",
            "offline_access"
        ]
    );
}

/// A declined widening leaves the session as it was: the poll says so, the
/// browser's token keeps working, and the session still falls short.
#[tokio::test]
async fn a_declined_widening_leaves_the_session_as_it_was() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    let (sid, narrow_token) = limited_browser(&db);
    let request_id = limited_request_id(
        &get_authorize(&g.router, &narrow_token, &app_query_prompting_consent()).await,
    );
    let widening_id = ask_to_widen(&g, &narrow_token, &request_id).await;
    let res = as_owner(
        &g,
        &owner_token,
        "POST",
        &format!("/authorization/session-widenings/{widening_id}/deny"),
        "",
    )
    .await;
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "denied" })
    );
    let res = post_with_session(
        &g,
        &narrow_token,
        &format!("/oauth/session-widenings/{widening_id}/poll"),
    )
    .await;
    assert!(set_cookie_values(&res).is_empty());
    assert_eq!(body_json(res.into_body()).await["status"], "declined");
    let session = store_handle(&db)
        .read(|tx| tx.browser_session_by_sid(&sid))
        .expect("read")
        .expect("stored");
    assert_eq!(session.scopes, ["wildflower/launch", "patient/Patient.rs"]);
    let res = get_session_shortfall(&g.router, &narrow_token, &request_id).await;
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["patient/Observation.rs"])
    );
}

/// Only the browser whose request it is can ask, and only that browser's
/// session can poll the widening: anyone else gets the `404` an unknown id
/// gets.
#[tokio::test]
async fn another_browser_can_neither_ask_nor_poll() {
    let (g, _owner_token, db) = spin_up();
    seed_app(&db);
    let (_, session_token) = limited_browser(&db);
    let request_id = limited_request_id(
        &get_authorize(&g.router, &session_token, &app_query_prompting_consent()).await,
    );
    let (_, other_token) = limited_browser(&db);
    let res = post_with_session(
        &g,
        &other_token,
        &format!("/oauth/authorize/{request_id}/ask-to-widen"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(res.into_body()).await["error"],
        "AuthorizationRequestNotFound"
    );
    let widening_id = ask_to_widen(&g, &session_token, &request_id).await;
    let res = post_with_session(
        &g,
        &other_token,
        &format!("/oauth/session-widenings/{widening_id}/poll"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "error": "SessionWideningNotFound", "id": widening_id })
    );
}
