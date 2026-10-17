//! `/oauth/authorize` requires a browser session (#1231). A browser without
//! one is sent to the pairing page and comes back to the same request once
//! paired, with nothing parked, notified or consumed meanwhile, even when a
//! standing grant would cover the request. A browser with one gets the flow,
//! fast path included, and every code and refresh family the request earns
//! names the session of the browser that made it, never the approver's. The
//! status poll answers only that browser, and a launch that lapsed while the
//! browser paired asks for a new launch.

use wildflowerhealthio_authorization_server::domain::launch_context::{
    LaunchContext, LAUNCH_CONTEXT_TTL,
};
use wildflowerhealthio_authorization_server::domain::GrantTx as _;

use crate::common::*;

/// The FHIR web UI's (`helios-ui`) client in these tests, as `spin_up`
/// configures it.
const FHIR_UI_CLIENT_ID: &str = "fhir-ui-client";

/// The `/oauth/authorize` query the FHIR web UI sends: its client, its
/// callback on the server's origin, and `user/*.cruds`.
fn fhir_ui_query() -> String {
    let challenge = compute_code_challenge(CODE_VERIFIER);
    format!(
        "response_type=code&code_challenge_method=S256&client_id={FHIR_UI_CLIENT_ID}&\
         scope=user%2F*.cruds&code_challenge={challenge}&\
         redirect_uri=https%3A%2F%2Fruth.relay.example%2Fui%2Fcallback&state=xyz"
    )
}

/// `test-app`'s query for `read offline_access`, registered at
/// `https://app.example/cb`.
fn app_query() -> String {
    authorize_query("test-app", "read%20offline_access")
}

/// Register `test-app` for `read` and `offline_access`.
fn seed_app(db: &TestDb) {
    seed_client_with_redirect(
        db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
}

/// Park `query` from the browser holding `session_token`, then approve it on
/// the Owner's `owner_token` with `approve_body`, leaving a standing grant.
/// Returns the request id.
async fn park_and_approve(
    g: &AuthorizationServer,
    owner_token: &str,
    session_token: &str,
    query: &str,
    approve_body: &str,
) -> String {
    let request_id = parked_request_id(&get_authorize(&g.router, session_token, query).await);
    let res = approve_oauth_consent(g, owner_token, &request_id, approve_body.to_owned()).await;
    assert_eq!(res.status(), StatusCode::OK);
    request_id
}

/// The approval of `app_query`'s scopes.
const APPROVE_APP: &str =
    r#"{"approvedScopes":["read","offline_access"],"acknowledgedRegistration":true}"#;

/// The approval of `fhir_ui_query`'s scope.
const APPROVE_FHIR_UI: &str =
    r#"{"approvedScopes":["user/*.cruds"],"acknowledgedRegistration":true}"#;

/// The `next` a pairing-page `Location` (`pair?next=…`, relative to
/// `/oauth/authorize`) carries, decoded.
fn pairing_next(location: &str) -> String {
    let url = Url::parse(SERVER_ORIGIN)
        .and_then(|origin| origin.join("/oauth/authorize"))
        .and_then(|authorize| authorize.join(location))
        .expect("the pairing location resolves");
    assert_eq!(url.path(), "/oauth/pair", "{location}");
    url.query_pairs()
        .find(|(name, _)| name == "next")
        .map(|(_, next)| next.into_owned())
        .unwrap_or_else(|| panic!("{location} names a next"))
}

/// The `code` a client callback `Location` carries.
fn code_of(callback: &str) -> String {
    Url::parse(callback)
        .expect("a callback URL")
        .query_pairs()
        .find(|(name, _)| name == "code")
        .map(|(_, code)| code.into_owned())
        .unwrap_or_else(|| panic!("{callback} carries a code"))
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

/// Redeem `code` for `test-app`, returning the token response.
async fn redeem(g: &AuthorizationServer, code: &str) -> Value {
    let res = post_token(
        g,
        format!(
            "grant_type=authorization_code&client_id=test-app&code={code}&\
             code_verifier={CODE_VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await
}

/// The `sid` the refresh family `refresh_token` belongs to records.
fn family_sid(db: &TestDb, refresh_token: &str) -> Option<String> {
    store_handle(db)
        .refresh_token_with_family_by_hash(&token_storage_hash(refresh_token))
        .expect("read")
        .expect("the family")
        .1
        .sid
}

/// The `sid` claim of `token`, unverified.
fn sid_of(token: &str) -> String {
    decode_jwt_payload(token)["sid"]
        .as_str()
        .expect("the token names its browser session")
        .to_owned()
}

/// `POST /oauth/pair/start` with `next`, as the pairing page sends it on load.
async fn start_pairing(g: &AuthorizationServer, next: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::post("/oauth/pair/start").header("content-type", "application/json"),
            Body::from(serde_json::json!({ "next": next }).to_string()),
        ))
        .await
        .expect("oneshot")
}

/// A browser without a session is sent to the pairing page, never given a
/// code, though a standing grant covers its request: the FHIR web UI's client
/// and a hosted app's alike. Nothing is parked or raised for the Owner, its
/// launch is left unspent, and the pairing page accepts the `next` that
/// brings it back to the same request.
#[tokio::test]
async fn a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    for (query, approve_body) in [
        (fhir_ui_query(), APPROVE_FHIR_UI),
        (app_query(), APPROVE_APP),
    ] {
        park_and_approve(
            &g,
            &owner_token,
            &db.paired_browser_token,
            &query,
            approve_body,
        )
        .await;
    }
    let launch = g
        .launch_context_minter
        .mint("test-app")
        .expect("mint a launch");
    let launched_app_query = format!("{}&launch={launch}", app_query());
    let pending_before = newest_pending_consent(&db);

    let mut nexts = Vec::new();
    for query in [fhir_ui_query(), launched_app_query.clone()] {
        let res = get_authorize_without_session(&g.router, &query).await;
        assert_eq!(res.status(), StatusCode::FOUND, "{query}");
        let next = pairing_next(&location_of(&res));
        assert_eq!(next, format!("/oauth/authorize?{query}"));
        nexts.push(next);
    }
    assert_eq!(
        newest_pending_consent(&db),
        pending_before,
        "nothing parked"
    );

    for next in nexts {
        let started = start_pairing(&g, &next).await;
        assert_eq!(started.status(), StatusCode::OK);
        assert_eq!(body_json(started.into_body()).await["next"], next);
    }

    // The launch was left for the paired browser, which now takes the fast
    // path with it.
    let res = get_authorize(&g.router, &db.paired_browser_token, &launched_app_query).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert!(
        location_of(&res).starts_with("https://app.example/cb?code="),
        "{}",
        location_of(&res)
    );
}

/// A paired browser takes the fast path on a standing grant another browser
/// earned, and the code, tokens and refresh family name its own session.
/// Revoking that session ends them, and the app can't start again from a
/// browser without a session: the revoked browser is sent to pairing.
#[tokio::test]
async fn a_paired_browser_takes_the_fast_path_under_its_own_session_until_it_is_revoked() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    park_and_approve(
        &g,
        &owner_token,
        &db.paired_browser_token,
        &app_query(),
        APPROVE_APP,
    )
    .await;
    let (sid, session_token) = paired_browser_session(&db);

    let res = get_authorize(&g.router, &session_token, &app_query()).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    let issued = redeem(&g, &code_of(&location_of(&res))).await;
    let access_token = issued["access_token"].as_str().expect("an access token");
    let refresh_token = issued["refresh_token"].as_str().expect("a refresh token");
    assert_eq!(sid_of(access_token), sid);
    assert_eq!(
        family_sid(&db, refresh_token).as_deref(),
        Some(sid.as_str())
    );

    assert!(store_handle(&db)
        .revoke_browser_session(&sid, Utc::now())
        .expect("revoke"));
    let res = post_token(
        &g,
        format!("grant_type=refresh_token&client_id=test-app&refresh_token={refresh_token}"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(res.into_body()).await["error"], "invalid_grant");
    for res in [
        get_authorize(&g.router, &session_token, &app_query()).await,
        get_authorize_without_session(&g.router, &app_query()).await,
    ] {
        assert_eq!(res.status(), StatusCode::FOUND);
        pairing_next(&location_of(&res));
    }
}

/// A request a paired browser parks and the Owner approves from another
/// browser (the popup, a signed-in launcher) earns a code, tokens and a
/// refresh family that name the requesting browser's session, not the
/// approver's.
#[tokio::test]
async fn the_code_names_the_requesting_browser_s_session_not_the_approver_s() {
    let (g, _owner_token, db) = spin_up();
    seed_app(&db);
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let request_id = park_and_approve(
        &g,
        &owner_session_token,
        &db.paired_browser_token,
        &app_query(),
        APPROVE_APP,
    )
    .await;

    let res = get_authorization_status(&g.router, &db.paired_browser_token, &request_id).await;
    assert_eq!(res.status(), StatusCode::OK);
    let status = body_json(res.into_body()).await;
    assert_eq!(status["status"], "approved");
    let issued = redeem(&g, &code_of(status["redirect"].as_str().expect("redirect"))).await;
    let access_token = issued["access_token"].as_str().expect("an access token");
    let refresh_token = issued["refresh_token"].as_str().expect("a refresh token");
    assert_eq!(sid_of(access_token), db.paired_browser_sid);
    assert_ne!(sid_of(access_token), sid_of(&owner_session_token));
    assert_eq!(
        family_sid(&db, refresh_token).as_deref(),
        Some(db.paired_browser_sid.as_str())
    );
}

/// The status poll answers only the browser that parked the request: another
/// browser's session, and no session, get the same `404` as an unknown id, so
/// a leaked request id can't collect the code.
#[tokio::test]
async fn a_leaked_request_id_collects_nothing() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    let request_id = park_and_approve(
        &g,
        &owner_token,
        &db.paired_browser_token,
        &app_query(),
        APPROVE_APP,
    )
    .await;
    let (_, other_browser_token) = paired_browser_session(&db);

    let unknown = get_authorization_status(&g.router, &db.paired_browser_token, "no-such-id").await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    let unknown_error = body_json(unknown.into_body()).await["error"].clone();
    for res in [
        get_authorization_status(&g.router, &other_browser_token, &request_id).await,
        g.router
            .clone()
            .oneshot(build_request(
                Request::get(format!("/oauth/authorize/{request_id}")),
                Body::empty(),
            ))
            .await
            .expect("oneshot"),
    ] {
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_json(res.into_body()).await["error"], unknown_error);
    }

    let res = get_authorization_status(&g.router, &db.paired_browser_token, &request_id).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "approved");
}

/// A launch for this client that expired (as one may while the Owner approves
/// the browser's pairing) renders the local page asking the user to launch
/// the app again; a launch this server never minted is `invalid_request` back
/// to the app.
#[tokio::test]
async fn an_expired_launch_asks_for_a_new_launch_and_an_unknown_one_is_refused() {
    let (g, _owner_token, db) = spin_up();
    seed_app(&db);
    store_handle(&db)
        .with_connection(|tx| {
            tx.insert_launch_context(&LaunchContext::for_client(
                "lapsed".to_owned(),
                "test-app",
                None,
                Utc::now() - LAUNCH_CONTEXT_TTL,
            ))
        })
        .expect("plant a lapsed launch");

    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &format!("{}&launch=lapsed", app_query()),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let page = body_string(res.into_body()).await;
    assert!(page.contains("Launch expired"), "{page}");
    assert!(page.contains("Launch the app again"), "{page}");

    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &format!("{}&launch=never-minted", app_query()),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(
        location_of(&res),
        "https://app.example/cb?error=invalid_request&state=xyz"
    );
}
