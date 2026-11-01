//! Access-token revocation: the bearer gates check the shared revocation
//! store's denylist of `jti`s and its per-subject epochs, and the control
//! surfaces (logout, `POST /authorization/revocations`, revoking a grant)
//! write to it. A `jti` is a revocation handle, not a single-use nonce: a live
//! token keeps passing.

use crate::common::*;

/// A bearer is multi-use: the same live token authenticates again and again,
/// and revocation doesn't make it single-use.
#[tokio::test]
async fn gate_allows_a_live_token_across_repeated_requests() {
    let (g, owner_token, _db) = spin_up();
    for _ in 0..3 {
        let res = g
            .router
            .clone()
            .oneshot(owner_grants_probe(&owner_token))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::OK,
            "a live token must keep passing"
        );
    }
}

/// A live token whose `jti` is denylisted is rejected from then on.
#[tokio::test]
async fn gate_rejects_a_revoked_jti() {
    let (g, owner_token, db) = spin_up();
    // Live first.
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    // Denylist this token's jti; the same token is now rejected.
    let jti = jti_of(&owner_token);
    revocation_store_handle(&db)
        .revoke_jti(&jti, Utc::now(), Utc::now() + Duration::hours(1), "test")
        .expect("revoke");
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&owner_token))
        .await
        .expect("oneshot");
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "a revoked jti must be rejected by the gate"
    );
}

/// Bumping a subject's revocation epoch rejects every token issued to that
/// client before the epoch. The epoch is set a second ahead, because a
/// token's `iat` is whole seconds.
#[tokio::test]
async fn gate_rejects_after_subject_epoch_bump() {
    let (g, owner_token, db) = spin_up();
    // Bulk-revoke the Owner token's client's cohort. JWT `iat` is second-precision, so
    // advance the epoch one second past the mint second to unambiguously cover a
    // token minted moments ago in this test.
    revocation_store_handle(&db)
        .bump_subject_epoch(OWNER_TOKEN_CLIENT_ID, Utc::now() + Duration::seconds(1))
        .expect("bump");
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&owner_token))
        .await
        .expect("oneshot");
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "an epoch bump must revoke pre-epoch tokens"
    );
}

/// Logging out denylists the presented token's `jti`, so the same token no
/// longer authenticates.
#[tokio::test]
async fn logout_revokes_the_presented_jti() {
    let (g, owner_token, db) = spin_up();
    let jti = jti_of(&owner_token);
    // Log out, presenting the token as a bearer.
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::post("/authorization/logout")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}")),
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
        .oneshot(owner_grants_probe(&owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// `POST /authorization/revocations` with a `jti` and its `expiresAt`
/// denylists that token, even when it is the caller's own.
#[tokio::test]
async fn revocations_endpoint_revokes_by_jti() {
    let (g, owner_token, _db) = spin_up();
    let jti = jti_of(&owner_token);
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &owner_token,
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
        .oneshot(owner_grants_probe(&owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// `POST /authorization/revocations` with a `subject` bumps that client's
/// epoch, revoking every token it was issued before now.
#[tokio::test]
async fn revocations_endpoint_bulk_revokes_by_subject() {
    let (g, owner_token, db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &owner_token,
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

/// A revocation body is one mode or the other: a `jti` without its
/// `expiresAt`, both modes, neither, or an `expiresAt` already past is `400`.
#[tokio::test]
async fn revocations_endpoint_rejects_invalid_bodies() {
    let (g, owner_token, _db) = spin_up();
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
            .oneshot(owner_revocation_request(&owner_token, body.clone()))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "invalid revocation body must 400: {body}"
        );
    }
}

/// Revoking without a bearer is `401`.
#[tokio::test]
async fn revocations_endpoint_requires_owner_auth() {
    let (g, _owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::post("/authorization/revocations")
                .header("host", "127.0.0.1")
                .header("content-type", "application/json"),
            Body::from(serde_json::json!({ "subject": "c" }).to_string()),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// Revoking an authorization-code grant bumps its client's revocation epoch,
/// so the client's live access tokens end with the standing consent.
#[tokio::test]
async fn revoking_a_grant_bumps_the_client_revocation_epoch() {
    let (g, owner_token, db) = spin_up();
    // Seed a client + a grant for it.
    seed_client_with_redirect(&db, "granted-client", "https://app.example/cb", &["read"]);
    let store = store_handle(&db);
    store
        .write(|tx| {
            tx.create_authorization_code_grant(
                &wildflowerhealthio_authorization_server::domain::grant::AuthorizationCodeGrant {
                    id: "grant-1".to_string(),
                    client_id: "granted-client".to_string(),
                    scopes: vec!["read".to_string()],
                    granted_at: Utc::now(),
                    last_used_at: None,
                    patient: None,
                    redirect_uri: Url::parse("https://app.example/cb").expect("url"),
                },
            )
        })
        .expect("create grant");
    // Revoke it.
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::delete("/authorization/grants/grant-1")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}")),
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

/// The Owner's list of authorized devices revokes a device through the same
/// `DELETE /authorization/grants/{id}` route, so revoking a device grant bumps
/// the client's revocation epoch exactly as revoking an authorization-code
/// grant does. The epoch is keyed on `sub = client_id`, so revoking one device
/// grant revokes every live access token of that client.
#[tokio::test]
async fn revoking_a_device_grant_bumps_the_client_revocation_epoch() {
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    let store = store_handle(&db);
    store
        .write(|tx| {
            tx.create_device_grant(
                &wildflowerhealthio_authorization_server::domain::grant::DeviceGrant {
                    id: "device-grant-1".to_string(),
                    client_id: "device-client".to_string(),
                    scopes: vec!["read".to_string()],
                    granted_at: Utc::now(),
                    last_used_at: None,
                    patient: None,
                    device_name: "Ada's laptop".to_string(),
                },
            )
        })
        .expect("create device grant");
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::delete("/authorization/grants/device-grant-1")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}")),
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

/// The status `token` gets from the `/authorization` bearer gate.
async fn gate_status(g: &AuthorizationServer, token: &str) -> StatusCode {
    g.router
        .clone()
        .oneshot(owner_grants_probe(token))
        .await
        .expect("oneshot")
        .status()
}

/// A token issued to the host app's client, holding all it may: `openid`,
/// which reaches no `/authorization/*` scope gate.
fn mint_host_app_token(db: &TestDb) -> String {
    mint_client_token(db, WILDFLOWER_HOST_APP_CLIENT_ID, &["openid"])
}

/// Revoking the Wildflower host app's subject revokes a token issued to it,
/// like any other client's: the gate that forbade it now rejects it outright.
#[tokio::test]
async fn revoking_the_host_app_s_subject_revokes_its_tokens() {
    let (g, owner_token, db) = spin_up();
    let host_app_token = mint_host_app_token(&db);
    assert_eq!(
        gate_status(&g, &host_app_token).await,
        StatusCode::FORBIDDEN
    );
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &owner_token,
            serde_json::json!({ "subject": WILDFLOWER_HOST_APP_CLIENT_ID }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        gate_status(&g, &host_app_token).await,
        StatusCode::UNAUTHORIZED,
        "the token issued to the host app is revoked"
    );
}

/// Revoking a grant of the Wildflower host app's client deletes it and bumps
/// the host app's epoch like any other client's.
#[tokio::test]
async fn revoking_a_grant_of_the_host_app_s_client_bumps_its_epoch() {
    let (g, owner_token, db) = spin_up();
    let host_app_token = mint_host_app_token(&db);
    store_handle(&db)
        .write(|tx| {
            tx.create_device_grant(
                &wildflowerhealthio_authorization_server::domain::grant::DeviceGrant {
                    id: "host-app-grant".to_string(),
                    client_id: WILDFLOWER_HOST_APP_CLIENT_ID.to_string(),
                    scopes: wildflowerhealthio_authorization_server::default_host_app_client_scopes(
                    ),
                    granted_at: Utc::now(),
                    last_used_at: None,
                    patient: None,
                    device_name: "The Owner's laptop".to_string(),
                },
            )
        })
        .expect("create the host app's grant");
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::delete("/authorization/grants/host-app-grant")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(store_handle(&db)
        .read(|tx| tx.grant_by_id("host-app-grant"))
        .expect("query")
        .is_none());
    assert_eq!(
        gate_status(&g, &host_app_token).await,
        StatusCode::UNAUTHORIZED
    );
}
