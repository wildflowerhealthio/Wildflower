//! `HostConsentDecider`: the host reads and decides a server's pending consents
//! in-process, with no token, through the capabilities behind
//! `/authorization/oauth-consents/*` and `/authorization/devices/*`. A decision moves the
//! consent head as one made over HTTP does.

use wildflowerhealthio_authorization_server::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, ClientRegistrationVerdict, ConsentOutcome,
    HostConsentDecider,
};

use crate::common::*;

#[tokio::test]
async fn the_host_reads_and_approves_a_parked_authorize_request() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let request_id =
        parked_request_id(&get_authorize(&g.router, &authorize_query("test-app", "read")).await);
    let decider = HostConsentDecider::new(g.state.clone());

    let consent = decider
        .oauth_consent(&request_id)
        .expect("the parked request");
    assert_eq!(consent.request.client_id, "test-app");
    assert_eq!(consent.client_name, "Integration Test Client");
    assert_eq!(consent.request.requested_scopes, vec!["read".to_owned()]);
    assert_eq!(
        consent.requested_redirect_uri.as_str(),
        "https://app.example/cb"
    );
    assert_eq!(
        consent.registration_verdict,
        ClientRegistrationVerdict::Registered
    );

    let outcome = decider
        .approve_oauth(
            &request_id,
            ApproveOAuthConsentInput {
                owner_approved_scopes: vec!["read".to_owned()],
                patient: None,
                acknowledged_registration: false,
            },
            Utc::now(),
        )
        .expect("approve");
    assert!(matches!(outcome, ConsentOutcome::Approved { .. }));
    assert_eq!(
        pending_consent_head(&db),
        None,
        "the decision moves the head"
    );
    assert_eq!(
        store_handle(&db)
            .authorization_request_by_id(&request_id)
            .unwrap()
            .unwrap()
            .status,
        RequestStatus::Approved,
    );
}

/// The host approves with the Owner's authority, not the host app's client's:
/// a client trusted on first use is granted `system/*.cruds`, a scope the host
/// app's client may not hold.
#[tokio::test]
async fn the_host_approves_a_scope_the_host_app_s_client_may_not_hold() {
    let (g, _owner_token, db) = spin_up();
    let host_app_client = store_handle(&db)
        .client_by_id(WILDFLOWER_HOST_APP_CLIENT_ID)
        .unwrap()
        .expect("the seeded host app's client");
    assert_eq!(host_app_client.allowed_scopes, vec!["openid".to_owned()]);
    let request_id = parked_request_id(
        &get_authorize(&g.router, &authorize_query("tofu-app", "system%2F*.cruds")).await,
    );
    let decider = HostConsentDecider::new(g.state.clone());
    assert_eq!(
        decider
            .oauth_consent(&request_id)
            .expect("the parked request")
            .registration_verdict,
        ClientRegistrationVerdict::New
    );

    let outcome = decider
        .approve_oauth(
            &request_id,
            ApproveOAuthConsentInput {
                owner_approved_scopes: vec!["system/*.cruds".to_owned()],
                patient: None,
                acknowledged_registration: true,
            },
            Utc::now(),
        )
        .expect("approve");
    assert!(matches!(outcome, ConsentOutcome::Approved { .. }));
    assert_eq!(
        store_handle(&db)
            .authorization_request_by_id(&request_id)
            .unwrap()
            .unwrap()
            .granted_scopes,
        Some(vec!["system/*.cruds".to_owned()]),
    );
}

#[tokio::test]
async fn the_host_reads_approves_and_denies_device_requests() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let mut user_codes = Vec::new();
    for _ in 0..2 {
        let res = g
            .router
            .clone()
            .oneshot(loopback_request(
                Request::post("/oauth/device_authorization")
                    .header("content-type", "application/x-www-form-urlencoded"),
                Body::from("client_id=integration-test-app&scope=system%2F*.cruds"),
            ))
            .await
            .expect("oneshot");
        let body = body_json(res.into_body()).await;
        user_codes.push(body["user_code"].as_str().expect("user_code").to_owned());
    }
    let decider = HostConsentDecider::new(g.state.clone());

    let consent = decider.device_consent(&user_codes[0]).expect("the request");
    assert_eq!(consent.request.client_id, TEST_CLIENT_ID);
    assert_eq!(
        consent.request.requested_scopes,
        vec!["system/*.cruds".to_owned()]
    );
    let outcome = decider
        .approve_device(
            &user_codes[0],
            ApproveDeviceConsentInput {
                owner_approved_scopes: vec!["system/*.cruds".to_owned()],
                patient: None,
                device_name: None,
            },
            Utc::now(),
        )
        .expect("approve");
    assert_eq!(outcome, ConsentOutcome::Approved { redirect: None });
    assert_eq!(
        pending_consent_head(&db),
        Some(PendingConsentHead::Device {
            user_code: user_codes[1].clone()
        }),
        "the next request is the head once the first is decided",
    );

    decider.deny_device(&user_codes[1]).expect("deny");
    assert_eq!(pending_consent_head(&db), None);
    assert_eq!(
        decider.deny_device(&user_codes[1]),
        Err(
            wildflowerhealthio_authorization_server::domain::authorization_server_error::AuthorizationServerError::DeviceConsentNotFound {
                user_code: user_codes[1].clone()
            }
        ),
        "a decided request is no longer pending",
    );
}
