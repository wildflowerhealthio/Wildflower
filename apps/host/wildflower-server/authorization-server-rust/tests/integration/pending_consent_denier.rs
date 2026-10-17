use crate::common::*;
use wildflowerhealthio_authorization_server::domain::authorization_server_error::AuthorizationServerError;

/// The status the wait page polls for the code request `request_id`.
async fn wait_page_status(g: &AuthorizationServer, request_id: &str) -> Value {
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await
}

/// The host's in-process Deny takes the consent card's deny path: the wait
/// page ends as denied, with the client's `access_denied` callback, and the
/// request no longer counts as pending.
#[tokio::test]
async fn the_denier_denies_a_code_request_and_settles_its_wait_page() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let request_id =
        parked_request_id(&get_authorize(&g.router, &authorize_query("test-app", "read")).await);

    g.pending_consent_denier
        .deny(ConsentKey::OAuth {
            id: request_id.clone(),
        })
        .await
        .expect("the deny");

    let status = wait_page_status(&g, &request_id).await;
    assert_eq!(status["status"], "denied");
    assert_eq!(
        status["redirect"],
        "https://app.example/cb?error=access_denied&state=xyz"
    );
    assert_eq!(newest_pending_consent(&db), None);
}

/// A device request denied in-process answers its device's next poll with
/// `access_denied`.
#[tokio::test]
async fn the_denier_denies_a_device_request() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    plant_device_request(
        &store_handle(&db),
        TEST_CLIENT_ID,
        "dev-pending",
        &[TEST_CLIENT_SCOPE],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    g.pending_consent_denier
        .deny(ConsentKey::Device {
            user_code: "WILD-FLWR".to_owned(),
        })
        .await
        .expect("the deny");

    let poll = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
         client_id=integration-test-app&device_code=dev-pending",
    )
    .await;
    assert_eq!(
        body_json(poll.into_body()).await,
        serde_json::json!({ "error": "access_denied" })
    );
}

/// A request the Owner already approved stays approved: the deny finds no
/// pending request and changes nothing.
#[tokio::test]
async fn denying_a_request_already_approved_leaves_it_approved() {
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let request_id =
        parked_request_id(&get_authorize(&g.router, &authorize_query("test-app", "read")).await);
    let approved = approve_oauth_consent(
        &g,
        &owner_token,
        &request_id,
        r#"{"approvedScopes":["read"],"patient":null,"acknowledgedRegistration":true}"#.to_owned(),
    )
    .await;
    assert_eq!(approved.status(), StatusCode::OK);

    let denied = g
        .pending_consent_denier
        .deny(ConsentKey::OAuth {
            id: request_id.clone(),
        })
        .await;
    assert!(
        matches!(
            denied,
            Err(AuthorizationServerError::OAuthConsentNotFound { ref id }) if *id == request_id
        ),
        "{denied:?}"
    );
    assert_eq!(
        store_handle(&db)
            .authorization_request_by_id(&request_id)
            .expect("query")
            .expect("the request")
            .status,
        RequestStatus::Approved
    );
    assert_eq!(
        wait_page_status(&g, &request_id).await["status"],
        "approved"
    );
}
