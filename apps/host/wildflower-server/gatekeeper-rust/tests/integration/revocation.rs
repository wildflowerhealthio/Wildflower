use crate::common::*;

#[tokio::test]
async fn gate_allows_a_live_token_across_repeated_requests() {
    // Regression guard for the reframe: the same multi-use bearer must
    // authenticate again and again — revocation must NOT reintroduce single-use.
    let (g, host_owner_token, _db) = spin_up();
    for _ in 0..3 {
        let res = g
            .router
            .clone()
            .oneshot(owner_grants_probe(&host_owner_token))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::OK,
            "a live token must keep passing"
        );
    }
}

#[tokio::test]
async fn gate_rejects_a_revoked_jti() {
    let (g, host_owner_token, db) = spin_up();
    // Live first.
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    // Denylist this token's jti; the same token is now rejected.
    let jti = jti_of(&host_owner_token);
    revocation_store_handle(&db)
        .revoke_jti(&jti, Utc::now() + Duration::hours(1), "test")
        .expect("revoke");
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "a revoked jti must be rejected by the gate"
    );
}

#[tokio::test]
async fn gate_rejects_after_subject_epoch_bump() {
    let (g, host_owner_token, db) = spin_up();
    // Bulk-revoke the host client's cohort. JWT `iat` is second-precision, so
    // advance the epoch one second past the mint second to unambiguously cover a
    // token minted moments ago in this test.
    revocation_store_handle(&db)
        .bump_subject_epoch("wildflower-host", Utc::now() + Duration::seconds(1))
        .expect("bump");
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "an epoch bump must revoke pre-epoch tokens"
    );
}

#[tokio::test]
async fn logout_revokes_the_presented_jti() {
    let (g, host_owner_token, db) = spin_up();
    let jti = jti_of(&host_owner_token);
    // Log out, presenting the token as a bearer.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/access/logout")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    // The presented token's jti is now denylisted...
    assert!(
        revocation_store_handle(&db)
            .is_revoked_by_jti(&jti)
            .expect("query"),
        "logout must denylist the presented token's jti"
    );
    // ...and the same token no longer authenticates.
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revocations_endpoint_revokes_by_jti() {
    let (g, host_owner_token, _db) = spin_up();
    let jti = jti_of(&host_owner_token);
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &host_owner_token,
            serde_json::json!({
                "jti": jti,
                "expiresAt": (Utc::now() + Duration::hours(1)).to_rfc3339(),
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    // The token it just revoked (its own) no longer authenticates.
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revocations_endpoint_bulk_revokes_by_subject() {
    let (g, host_owner_token, db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &host_owner_token,
            serde_json::json!({ "subject": "some-client" }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    // The subject's epoch was bumped to ~now: a token that subject holds issued
    // an hour ago is revoked (checked directly, deterministically).
    assert!(
        revocation_store_handle(&db)
            .is_revoked(None, Some(Utc::now() - Duration::hours(1)), "some-client")
            .expect("query"),
        "subject-mode revoke must bump the subject epoch"
    );
}

#[tokio::test]
async fn revocations_endpoint_rejects_invalid_bodies() {
    let (g, host_owner_token, _db) = spin_up();
    let bad_bodies = [
        // jti without the required expiresAt
        serde_json::json!({ "jti": "abc" }),
        // both modes at once
        serde_json::json!({ "jti": "abc", "expiresAt": Utc::now().to_rfc3339(), "subject": "c" }),
        // neither mode
        serde_json::json!({}),
        // jti with an expiresAt already in the past (stale/mistyped)
        serde_json::json!({
            "jti": "abc",
            "expiresAt": (Utc::now() - Duration::hours(1)).to_rfc3339(),
        }),
    ];
    for body in bad_bodies {
        let res = g
            .router
            .clone()
            .oneshot(owner_revocation_request(&host_owner_token, body.clone()))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "invalid revocation body must 400: {body}"
        );
    }
}

#[tokio::test]
async fn revocations_endpoint_requires_owner_auth() {
    let (g, _host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/access/revocations")
                .header("host", "127.0.0.1")
                .header("content-type", "application/json"),
            Body::from(serde_json::json!({ "subject": "c" }).to_string()),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoking_a_grant_bumps_the_client_revocation_epoch() {
    let (g, host_owner_token, db) = spin_up();
    // Seed a client + a grant for it.
    seed_client_with_redirect(&db, "granted-client", "https://app.example/cb", &["read"]);
    let store = store_handle(&db);
    store
        .create_authorization_code_grant(&gatekeeper_rust::domain::grant::AuthorizationCodeGrant {
            id: "grant-1".to_string(),
            client_id: "granted-client".to_string(),
            scopes: vec!["read".to_string()],
            granted_at: Utc::now(),
            last_used_at: None,
            patient: None,
            redirect_uri: Url::parse("https://app.example/cb").expect("url"),
        })
        .expect("create grant");
    // Revoke it.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::delete("/access/grants/grant-1")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    // The client's live access tokens are now revoked via the epoch — a token
    // it holds issued an hour ago reads back revoked.
    assert!(
        revocation_store_handle(&db)
            .is_revoked(
                None,
                Some(Utc::now() - Duration::hours(1)),
                "granted-client"
            )
            .expect("query"),
        "grant revoke must bump the client's revocation epoch"
    );
}

#[tokio::test]
async fn revoking_a_device_grant_bumps_the_client_revocation_epoch() {
    // Integration point with the polymorphic device grants (#332): the
    // Authorized Devices list revokes a device through the same
    // `DELETE /access/grants/{id}` surface, so token revocation must fire for a
    // `DeviceCode` grant exactly as it does for an authorization-code one. This
    // is the token-revocation half of "revoke this device" — the access-token
    // epoch is keyed on `sub = client_id`, so revoking one device grant revokes
    // that client's live access tokens (per-device token handles are deferred —
    // see #269).
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    let store = store_handle(&db);
    store
        .create_device_grant(&gatekeeper_rust::domain::grant::DeviceGrant {
            id: "device-grant-1".to_string(),
            client_id: "device-client".to_string(),
            scopes: vec!["read".to_string()],
            granted_at: Utc::now(),
            last_used_at: None,
            patient: None,
            device_name: "Ada's laptop".to_string(),
        })
        .expect("create device grant");
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::delete("/access/grants/device-grant-1")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(
        revocation_store_handle(&db)
            .is_revoked(None, Some(Utc::now() - Duration::hours(1)), "device-client")
            .expect("query"),
        "revoking a device grant must bump the client's revocation epoch"
    );
}
