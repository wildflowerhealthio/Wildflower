//! `HostConsentDecider`: the host reads and decides a server's pending consents
//! in-process, with no token, through the capabilities behind
//! `/access/oauth-consents/*` and `/access/devices/*`. A decision moves the
//! consent head as one made over HTTP does.

use gatekeeper_rust::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, ClientRegistrationVerdict, ConsentOutcome,
    HostConsentDecider,
};

use crate::common::*;

#[tokio::test]
async fn the_host_reads_and_approves_a_parked_authorize_request() {
    let (g, _host_owner_token, db) = spin_up();
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

#[tokio::test]
async fn the_host_reads_approves_and_denies_device_requests() {
    let (g, _host_owner_token, db) = spin_up();
    let mut user_codes = Vec::new();
    for _ in 0..2 {
        let res = g
            .router
            .clone()
            .oneshot(loopback_request(
                Request::post("/oauth/device_authorization")
                    .header("content-type", "application/x-www-form-urlencoded"),
                Body::from("client_id=wildflower-host&scope=system%2F*.cruds"),
            ))
            .await
            .expect("oneshot");
        let body = body_json(res.into_body()).await;
        user_codes.push(body["user_code"].as_str().expect("user_code").to_owned());
    }
    let decider = HostConsentDecider::new(g.state.clone());

    let consent = decider.device_consent(&user_codes[0]).expect("the request");
    assert_eq!(consent.request.client_id, "wildflower-host");
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
            gatekeeper_rust::domain::gatekeeper_error::GatekeeperError::DeviceConsentNotFound {
                user_code: user_codes[1].clone()
            }
        ),
        "a decided request is no longer pending",
    );
}
