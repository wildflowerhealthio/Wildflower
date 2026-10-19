//! A request asking for more than the browser's session holds stops at the
//! limited page (#1312): `/oauth/authorize` parks it unacknowledged and sends
//! the browser to `/oauth/authorize/{id}/limited`, which reads what the
//! session lacks and goes on (`…/continue`) or cancels (`…/cancel`). Until it
//! goes on, the Owner isn't asked about it and nothing decides it. Going on
//! takes the branch the start would have: the fast path under a standing
//! grant, or the consent card or the wait page. Only the browser that made the
//! request can read, continue or cancel it. Once a browser session has gone on
//! for an app, its later requests for that app skip the page.

use wildflowerhealthio_authorization_server::domain::authorization_request::AuthorizationRequest;

use crate::common::*;

/// `test-app`'s query for `patient/Patient.rs patient/Observation.rs
/// offline_access`, registered at `https://app.example/cb`.
fn app_query() -> String {
    authorize_query(
        "test-app",
        "patient%2FPatient.rs%20patient%2FObservation.rs%20offline_access",
    )
}

/// Register `test-app` for `app_query`'s scopes and `wildflower/launch`.
fn seed_app(db: &TestDb) {
    seed_client_with_redirect(
        db,
        "test-app",
        "https://app.example/cb",
        &[
            "patient/Patient.rs",
            "patient/Observation.rs",
            "offline_access",
            "wildflower/launch",
        ],
    );
}

/// The approval of `app_query`'s scopes.
const APPROVE_APP: &str = r#"{"approvedScopes":["patient/Patient.rs","patient/Observation.rs","offline_access"],"acknowledgedRegistration":true}"#;

/// A browser paired with `wildflower/launch` and `patient/Patient.rs` alone:
/// it falls short of `app_query` by `patient/Observation.rs`.
fn limited_browser(db: &TestDb) -> (String, String) {
    paired_browser_session_holding(db, &["wildflower/launch", "patient/Patient.rs"])
}

/// Leave a standing grant for `app_query`, earned by the test's default
/// paired browser, which holds every FHIR scope.
async fn approve_a_standing_grant(g: &AuthorizationServer, owner_token: &str, db: &TestDb) {
    let request_id =
        parked_request_id(&get_authorize(&g.router, &db.paired_browser_token, &app_query()).await);
    let res = approve_oauth_consent(g, owner_token, &request_id, APPROVE_APP.to_owned()).await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// Redeem `code` for `test-app`, returning the token response.
async fn redeem(g: &AuthorizationServer, code: &str) -> Value {
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(format!(
                "grant_type=authorization_code&client_id=test-app&code={code}&\
                 code_verifier={CODE_VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"
            )),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await
}

/// The `code` a client callback carries.
fn code_of(callback: &str) -> String {
    Url::parse(callback)
        .expect("a callback URL")
        .query_pairs()
        .find(|(name, _)| name == "code")
        .map(|(_, code)| code.into_owned())
        .unwrap_or_else(|| panic!("{callback} carries a code"))
}

/// A standing grant covers the request, but the browser's session falls
/// short of it: the request parks on the limited page with nothing issued and
/// nothing raised, the page reads the app and what the session lacks, and
/// going on issues a code narrowed to the session.
#[tokio::test]
async fn the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    approve_a_standing_grant(&g, &owner_token, &db).await;
    let (_, session_token) = limited_browser(&db);

    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);
    assert_eq!(newest_pending_consent(&db), None, "the Owner isn't asked");
    assert_eq!(
        store_handle(&db)
            .read(|tx| tx.authorization_code_by_request_id(&request_id))
            .expect("read"),
        None,
        "no code yet"
    );

    let res = get_session_shortfall(&g.router, &session_token, &request_id).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the limited page's read");
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "clientName": "Integration Test Client",
            "missingScopes": ["patient/Observation.rs"],
        })
    );

    let callback = continue_past_session_shortfall(&g.router, &session_token, &request_id).await;
    assert!(
        callback.starts_with("https://app.example/cb?code="),
        "{callback}"
    );
    let issued = redeem(&g, &code_of(&callback)).await;
    assert_eq!(issued["scope"], "patient/Patient.rs offline_access");
    assert_eq!(newest_pending_consent(&db), None);

    let res = post_session_shortfall(&g.router, &session_token, &request_id, "continue").await;
    assert_eq!(
        res.status(),
        StatusCode::NOT_FOUND,
        "a request goes on once"
    );
}

/// Once a browser session has gone on past the limited page for an app, its
/// next request for that app goes straight on (here the fast path); another
/// session, and the same session asking for another app, still stop at it.
#[tokio::test]
async fn a_session_that_went_on_for_an_app_skips_the_limited_page_for_it() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    seed_client_with_redirect(
        &db,
        "other-app",
        "https://app.example/cb",
        &[
            "patient/Patient.rs",
            "patient/Observation.rs",
            "offline_access",
        ],
    );
    approve_a_standing_grant(&g, &owner_token, &db).await;
    let (_, session_token) = limited_browser(&db);
    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);
    continue_past_session_shortfall(&g.router, &session_token, &request_id).await;

    let res = get_authorize(&g.router, &session_token, &app_query()).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    let callback = location_of(&res);
    assert!(
        callback.starts_with("https://app.example/cb?code="),
        "{callback}"
    );
    let issued = redeem(&g, &code_of(&callback)).await;
    assert_eq!(issued["scope"], "patient/Patient.rs offline_access");

    let (_, other_session_token) = limited_browser(&db);
    limited_request_id(&get_authorize(&g.router, &other_session_token, &app_query()).await);
    let other_app_query = authorize_query(
        "other-app",
        "patient%2FPatient.rs%20patient%2FObservation.rs%20offline_access",
    );
    limited_request_id(&get_authorize(&g.router, &session_token, &other_app_query).await);
}

/// A Continue for an app disabled since its request parked denies the
/// request and answers the page, in its JSON, with the app's `access_denied`
/// callback.
#[tokio::test]
async fn continue_for_an_app_disabled_since_denies_the_request() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    let (_, session_token) = limited_browser(&db);
    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);
    let res = disable_client(&g, &owner_token, "test-app", Utc::now()).await;
    assert!(res.status().is_success(), "{}", res.status());

    let callback = continue_past_session_shortfall(&g.router, &session_token, &request_id).await;
    assert_eq!(
        callback,
        "https://app.example/cb?error=access_denied\
         &error_description=The+supplied+client_id+has+been+disabled.&state=xyz"
    );
    let status = get_authorization_status(&g.router, &session_token, &request_id).await;
    assert_eq!(body_json(status.into_body()).await["status"], "denied");
}

/// Cancel sends the browser back to the app with `access_denied`, and the
/// request can't be continued or read after. The next request from that
/// browser stops at the limited page again.
#[tokio::test]
async fn cancel_answers_the_app_access_denied() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    approve_a_standing_grant(&g, &owner_token, &db).await;
    let (_, session_token) = limited_browser(&db);
    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);

    let res = post_session_shortfall(&g.router, &session_token, &request_id, "cancel").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["location"],
        "https://app.example/cb?error=access_denied\
         &error_description=The+request+was+declined.&state=xyz"
    );
    for res in [
        post_session_shortfall(&g.router, &session_token, &request_id, "continue").await,
        get_session_shortfall(&g.router, &session_token, &request_id).await,
    ] {
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
    let status = get_authorization_status(&g.router, &session_token, &request_id).await;
    assert_eq!(body_json(status.into_body()).await["status"], "denied");
    limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);
}

/// A request waiting on its limited page isn't the Owner's to see or decide:
/// the newest pending consent skips it, and the consent read, approve, deny
/// and ask-owner all `404`. Once the browser goes on, the Owner sees and
/// approves it.
#[tokio::test]
async fn the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    let (_, session_token) = limited_browser(&db);
    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);

    assert_eq!(newest_pending_consent(&db), None);
    let owner_request = |method: &str, action: &str| {
        let uri = format!("/authorization/oauth-consents/{request_id}{action}");
        build_request(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json"),
            Body::from(if action == "/approve" {
                APPROVE_APP
            } else {
                ""
            }),
        )
    };
    for (method, action) in [
        ("GET", ""),
        ("POST", "/approve"),
        ("POST", "/deny"),
        ("POST", "/ask-owner"),
    ] {
        let res = g
            .router
            .clone()
            .oneshot(owner_request(method, action))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{method} {action}");
    }

    assert_eq!(
        continue_past_session_shortfall(&g.router, &session_token, &request_id).await,
        format!("/oauth/authorize/{request_id}/wait")
    );
    assert!(matches!(
        newest_pending_consent(&db),
        Some(NewestPendingConsent::OAuth { ref id, .. }) if *id == request_id
    ));
    let res = approve_oauth_consent(&g, &owner_token, &request_id, APPROVE_APP.to_owned()).await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// Another browser's session, and a browser without one, get the `404` an
/// unknown id gets on the read, Continue and Cancel, and the request still
/// waits for its own browser.
#[tokio::test]
async fn another_browser_can_neither_read_nor_continue_nor_cancel() {
    let (g, _owner_token, db) = spin_up();
    seed_app(&db);
    let (_, session_token) = limited_browser(&db);
    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);
    let (_, other_browser_token) = limited_browser(&db);
    let owner_session_token = signed_in_owner_session_token(&g).await;

    for token in [&other_browser_token, &owner_session_token] {
        let res = get_session_shortfall(&g.router, token, &request_id).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body_json(res.into_body()).await["error"],
            "AuthorizationRequestNotFound"
        );
        for action in ["continue", "cancel"] {
            let res = post_session_shortfall(&g.router, token, &request_id, action).await;
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{action}");
        }
    }
    for (method, path) in [
        (
            "GET",
            format!("/oauth/authorize/{request_id}/session-shortfall"),
        ),
        ("POST", format!("/oauth/authorize/{request_id}/continue")),
        ("POST", format!("/oauth/authorize/{request_id}/cancel")),
    ] {
        let res = g
            .router
            .clone()
            .oneshot(build_request(
                Request::builder().method(method).uri(&path),
                Body::empty(),
            ))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{method} {path}");
    }

    let res = get_session_shortfall(&g.router, &session_token, &request_id).await;
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "it still waits for its browser"
    );
}

/// The Owner's session holds everything, so it never sees the limited page:
/// it goes to the consent card, or takes the fast path.
#[tokio::test]
async fn an_owner_session_never_sees_the_limited_page() {
    let (g, owner_token, db) = spin_up();
    seed_app(&db);
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let query = authorize_query(
        "test-app",
        "patient%2FPatient.rs%20patient%2FObservation.rs%20offline_access%20wildflower%2Flaunch",
    );

    let res = get_authorize(&g.router, &owner_session_token, &query).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert!(
        location_of(&res).ends_with("/consent"),
        "{}",
        location_of(&res)
    );

    approve_a_standing_grant(&g, &owner_token, &db).await;
    let res = get_authorize(&g.router, &owner_session_token, &app_query()).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert!(
        location_of(&res).starts_with("https://app.example/cb?code="),
        "{}",
        location_of(&res)
    );
}

/// With no standing grant, going on raises the request for the Owner on the
/// wait page, even from a browser that can decide consents: a code approval
/// takes every held access the request asks for, and the shortfall is held
/// access its session lacks (here `wildflower/launch` alone), so it can't
/// approve the request on its own card.
#[tokio::test]
async fn without_a_standing_grant_continue_raises_the_request_for_the_owner() {
    let (g, _owner_token, db) = spin_up();
    seed_app(&db);
    let launch_query = authorize_query(
        "test-app",
        "patient%2FPatient.rs%20patient%2FObservation.rs%20offline_access%20wildflower%2Flaunch",
    );
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let owner_sid = decode_jwt_payload(&owner_session_token)["sid"]
        .as_str()
        .expect("a browser session's token names its sid")
        .to_owned();
    let deciding_without_launch = mint_browser_session_token(
        &db,
        &owner_sid,
        &[
            "wildflower/AuthorizationRequest.r",
            "wildflower/AuthorizationRequest.u",
            "wildflower/Grant.c",
            "wildflower/Client.c",
            "wildflower/Client.u",
            "system/*.cruds",
        ],
    );

    let request_id = limited_request_id(
        &get_authorize(&g.router, &deciding_without_launch, &launch_query).await,
    );
    let res = get_session_shortfall(&g.router, &deciding_without_launch, &request_id).await;
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["wildflower/launch"])
    );
    assert_eq!(
        continue_past_session_shortfall(&g.router, &deciding_without_launch, &request_id).await,
        format!("/oauth/authorize/{request_id}/wait")
    );
    let consent = get_oauth_consent(&g, &deciding_without_launch, &request_id).await;
    assert_eq!(
        consent["missingApprovalScopes"],
        serde_json::json!(["wildflower/launch"])
    );
    assert!(matches!(
        newest_pending_consent(&db),
        Some(NewestPendingConsent::OAuth {
            ref id,
            decidable_in_requesting_browser: false,
            ..
        }) if *id == request_id
    ));

    let (_, session_token) = limited_browser(&db);
    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);
    assert_eq!(
        continue_past_session_shortfall(&g.router, &session_token, &request_id).await,
        format!("/oauth/authorize/{request_id}/wait")
    );
    assert!(matches!(
        newest_pending_consent(&db),
        Some(NewestPendingConsent::OAuth {
            ref id,
            decidable_in_requesting_browser: false,
            ..
        }) if *id == request_id
    ));
}

/// A request whose five minutes ran out on the limited page can't be read,
/// continued or cancelled, and the status poll reports it expired, as for any
/// other request.
#[tokio::test]
async fn an_expired_request_on_the_limited_page_goes_no_further() {
    let (g, _owner_token, db) = spin_up();
    seed_app(&db);
    let (_, session_token) = limited_browser(&db);
    let request_id =
        limited_request_id(&get_authorize(&g.router, &session_token, &app_query()).await);
    let parked = store_handle(&db)
        .read(|tx| tx.authorization_request_by_id(&request_id))
        .expect("read")
        .expect("parked");
    store_handle(&db)
        .write(|tx| {
            tx.insert_authorization_request(&AuthorizationRequest::new(
                NewAuthorizationRequest {
                    id: "lapsed".to_owned(),
                    client_id: parked.client_id().to_owned(),
                    requested_scopes: parked.requested_scopes().to_vec(),
                    ttl: Duration::minutes(5),
                    kind: parked.kind().clone(),
                },
                Utc::now() - Duration::minutes(5) - Duration::seconds(1),
            ))
        })
        .expect("plant a lapsed copy");

    for res in [
        get_session_shortfall(&g.router, &session_token, "lapsed").await,
        post_session_shortfall(&g.router, &session_token, "lapsed", "continue").await,
        post_session_shortfall(&g.router, &session_token, "lapsed", "cancel").await,
    ] {
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
    let res = get_authorization_status(&g.router, &session_token, "lapsed").await;
    assert_eq!(body_json(res.into_body()).await["status"], "error");
}
