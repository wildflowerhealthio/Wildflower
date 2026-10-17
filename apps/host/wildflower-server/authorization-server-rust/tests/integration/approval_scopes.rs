//! The approval scopes (#1232): an approved browser approves a code-flow or
//! device-flow request only when it can also create what the approval creates,
//! `wildflower/Grant.c` for the standing grant, plus `wildflower/Client.c` for
//! a new client's registration or `wildflower/Client.u` for a widened one. A
//! refused approval is a `403 InsufficientScope` naming what it lacks, and the
//! request stays pending for the Owner. The consent read says the same in
//! `missingApprovalScopes`, and the Owner's scopes cover every one.

use crate::common::*;

/// The scopes the test client asks for.
const REQUESTED_SCOPES: &str = "patient%2FObservation.rs%20openid";

/// The scopes every approved browser here holds: it reads and decides
/// requests, creates grants, and holds the resource scope the client asks for.
const APPROVER_SCOPES: &[&str] = &[
    "wildflower/AuthorizationRequest.r",
    "wildflower/AuthorizationRequest.u",
    "wildflower/Grant.c",
    "patient/Observation.rs",
];

/// An approval of what [`REQUESTED_SCOPES`] asks, acknowledging any
/// registration warning.
const APPROVE_REQUESTED: &str =
    r#"{"approvedScopes":["patient/Observation.rs","openid"],"acknowledgedRegistration":true}"#;

/// The token of a signed-in browser whose session holds `scopes` rather than
/// the Owner's: an approved browser, as far as the gates can tell.
async fn approved_browser_token(g: &AuthorizationServer, db: &TestDb, scopes: &[&str]) -> String {
    let owner_session_token = signed_in_owner_session_token(g).await;
    let sid = decode_jwt_payload(&owner_session_token)["sid"]
        .as_str()
        .expect("a browser session's token names its sid")
        .to_owned();
    mint_browser_session_token(db, &sid, scopes)
}

/// [`APPROVER_SCOPES`] plus `extra_scopes`.
fn approver_scopes_with(extra_scopes: &[&'static str]) -> Vec<&'static str> {
    [APPROVER_SCOPES, extra_scopes].concat()
}

/// A request from `test-app` for [`REQUESTED_SCOPES`], parked for the Owner.
async fn parked_request(g: &AuthorizationServer, db: &TestDb) -> String {
    parked_request_id(
        &get_authorize(
            &g.router,
            &db.paired_browser_token,
            &authorize_query("test-app", REQUESTED_SCOPES),
        )
        .await,
    )
}

/// The wait page's status poll for `request_id`.
async fn request_status(g: &AuthorizationServer, db: &TestDb, request_id: &str) -> Value {
    let res = get_authorization_status(&g.router, &db.paired_browser_token, request_id).await;
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await["status"].clone()
}

/// Assert `res` is the `403 InsufficientScope` naming exactly `missing_scopes`.
async fn assert_refused_for_lacking(res: axum::response::Response, missing_scopes: &[&str]) {
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "InsufficientScope");
    assert_eq!(body["missingScopes"], serde_json::json!(missing_scopes));
}

#[tokio::test]
async fn an_approved_browser_approves_a_registered_app_within_its_own_scopes() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let approver = approved_browser_token(&g, &db, APPROVER_SCOPES).await;
    let request_id = parked_request(&g, &db).await;

    let consent = get_oauth_consent(&g, &approver, &request_id).await;
    assert_eq!(consent["missingApprovalScopes"], serde_json::json!([]));
    let res = approve_oauth_consent(&g, &approver, &request_id, APPROVE_REQUESTED.to_owned()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "approved");
}

#[tokio::test]
async fn an_approved_browser_without_client_create_cannot_register_a_new_app() {
    let (g, _owner_token, db) = spin_up();
    // `test-app` is registered nowhere: the request is `new`.
    let approver = approved_browser_token(&g, &db, APPROVER_SCOPES).await;
    let request_id = parked_request(&g, &db).await;

    let consent = get_oauth_consent(&g, &approver, &request_id).await;
    assert_eq!(
        consent["missingApprovalScopes"],
        serde_json::json!(["wildflower/Client.c"])
    );
    let res = approve_oauth_consent(&g, &approver, &request_id, APPROVE_REQUESTED.to_owned()).await;
    assert_refused_for_lacking(res, &["wildflower/Client.c"]).await;
    assert_eq!(request_status(&g, &db, &request_id).await, "pending");
    assert!(
        store_handle(&db)
            .client_by_id("test-app")
            .expect("read")
            .is_none(),
        "the refused approval registered nothing"
    );

    let registering_approver =
        approved_browser_token(&g, &db, &approver_scopes_with(&["wildflower/Client.c"])).await;
    let res = approve_oauth_consent(
        &g,
        &registering_approver,
        &request_id,
        APPROVE_REQUESTED.to_owned(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "approved");
}

#[tokio::test]
async fn an_approved_browser_without_client_update_cannot_widen_an_app() {
    let (g, _owner_token, db) = spin_up();
    // Registered for `openid` alone, so asking for `patient/Observation.rs`
    // would widen it.
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["openid"]);
    let approver = approved_browser_token(&g, &db, APPROVER_SCOPES).await;
    let request_id = parked_request(&g, &db).await;

    let consent = get_oauth_consent(&g, &approver, &request_id).await;
    assert_eq!(
        consent["missingApprovalScopes"],
        serde_json::json!(["wildflower/Client.u"])
    );
    let res = approve_oauth_consent(&g, &approver, &request_id, APPROVE_REQUESTED.to_owned()).await;
    assert_refused_for_lacking(res, &["wildflower/Client.u"]).await;
    assert_eq!(request_status(&g, &db, &request_id).await, "pending");

    let widening_approver =
        approved_browser_token(&g, &db, &approver_scopes_with(&["wildflower/Client.u"])).await;
    let res = approve_oauth_consent(
        &g,
        &widening_approver,
        &request_id,
        APPROVE_REQUESTED.to_owned(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn an_approved_browser_without_grant_create_cannot_approve_a_code_request() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let approver = approved_browser_token(
        &g,
        &db,
        &[
            "wildflower/AuthorizationRequest.r",
            "wildflower/AuthorizationRequest.u",
            "patient/Observation.rs",
        ],
    )
    .await;
    let request_id = parked_request(&g, &db).await;

    let consent = get_oauth_consent(&g, &approver, &request_id).await;
    assert_eq!(
        consent["missingApprovalScopes"],
        serde_json::json!(["wildflower/Grant.c"])
    );
    let res = approve_oauth_consent(&g, &approver, &request_id, APPROVE_REQUESTED.to_owned()).await;
    assert_refused_for_lacking(res, &["wildflower/Grant.c"]).await;
    assert_eq!(request_status(&g, &db, &request_id).await, "pending");
}

#[tokio::test]
async fn an_approved_browser_without_grant_create_cannot_approve_a_device_request() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-1",
        &["read"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );
    let approver = approved_browser_token(
        &g,
        &db,
        &[
            "wildflower/AuthorizationRequest.r",
            "wildflower/AuthorizationRequest.u",
        ],
    )
    .await;

    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::post("/authorization/devices/WILD-FLWR/approve")
                .header("authorization", format!("Bearer {approver}"))
                .header("content-type", "application/json"),
            Body::from(r#"{"approvedScopes":["read"]}"#),
        ))
        .await
        .expect("oneshot");
    assert_refused_for_lacking(res, &["wildflower/Grant.c"]).await;
    assert_eq!(
        store_handle(&db)
            .authorization_request_by_id("dev-1")
            .expect("read")
            .expect("the request")
            .status,
        RequestStatus::Pending,
    );
}

/// The Owner's scopes cover every approval scope, so an Owner session lacks
/// none and registers a new app as before.
#[tokio::test]
async fn an_owner_session_lacks_no_approval_scope() {
    let (g, _owner_token, db) = spin_up();
    let owner_session_token = signed_in_owner_session_token(&g).await;
    // `test-app` is registered nowhere: the request is `new`.
    let request_id = parked_request(&g, &db).await;

    let consent = get_oauth_consent(&g, &owner_session_token, &request_id).await;
    assert_eq!(consent["missingApprovalScopes"], serde_json::json!([]));
    let res = approve_oauth_consent(
        &g,
        &owner_session_token,
        &request_id,
        APPROVE_REQUESTED.to_owned(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "approved");
}

/// A browser whose session can't create grants can't approve anything it
/// starts, so `/oauth/authorize` sends it to the wait page, not the consent
/// card.
#[tokio::test]
async fn a_browser_session_without_grant_create_goes_to_the_wait_page() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let cookie_for = |token: &str| format!("__Host-browser_session={token}");
    let authorize_with = |cookie: String| {
        let router = g.router.clone();
        async move {
            router
                .oneshot(build_request(
                    Request::get(format!(
                        "/oauth/authorize?{}",
                        authorize_query("test-app", REQUESTED_SCOPES)
                    ))
                    .header("cookie", cookie),
                    Body::empty(),
                ))
                .await
                .expect("oneshot")
        }
    };

    let without_grant_create = approved_browser_token(
        &g,
        &db,
        &[
            "wildflower/AuthorizationRequest.r",
            "wildflower/AuthorizationRequest.u",
        ],
    )
    .await;
    let location = location_of(&authorize_with(cookie_for(&without_grant_create)).await);
    assert!(location.ends_with("/wait"), "{location}");

    let with_grant_create = approved_browser_token(&g, &db, APPROVER_SCOPES).await;
    let location = location_of(&authorize_with(cookie_for(&with_grant_create)).await);
    assert!(location.ends_with("/consent"), "{location}");
}

/// A browser that can create grants but not register a client can't approve
/// a new app's request, so `/oauth/authorize` sends it to the wait page and
/// raises the request for the Owner (it isn't decidable in that browser); with
/// `wildflower/Client.c` it decides on the consent card.
#[tokio::test]
async fn a_browser_session_without_client_create_starting_a_new_app_s_request_waits_for_the_owner()
{
    let (g, _owner_token, db) = spin_up();
    let authorize_with = |token: String| {
        let router = g.router.clone();
        async move {
            router
                .oneshot(build_request(
                    Request::get(format!(
                        "/oauth/authorize?{}",
                        authorize_query("new-app", REQUESTED_SCOPES)
                    ))
                    .header("cookie", format!("__Host-browser_session={token}")),
                    Body::empty(),
                ))
                .await
                .expect("oneshot")
        }
    };

    let without_client_create = approved_browser_token(&g, &db, APPROVER_SCOPES).await;
    let location = location_of(&authorize_with(without_client_create).await);
    assert!(location.ends_with("/wait"), "{location}");
    assert!(matches!(
        newest_pending_consent(&db),
        Some(NewestPendingConsent::OAuth {
            decidable_in_requesting_browser: false,
            ..
        })
    ));

    let with_client_create =
        approved_browser_token(&g, &db, &approver_scopes_with(&["wildflower/Client.c"])).await;
    let location = location_of(&authorize_with(with_client_create).await);
    assert!(location.ends_with("/consent"), "{location}");
    assert!(matches!(
        newest_pending_consent(&db),
        Some(NewestPendingConsent::OAuth {
            decidable_in_requesting_browser: true,
            ..
        })
    ));
}
