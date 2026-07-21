use crate::common::*;

// ---------------------------------------------------------------------------
// Device-code grant state machine (RFC 8628 §3.4/§3.5)
// ---------------------------------------------------------------------------

/// First poll on a still-pending request returns `authorization_pending`; an
/// immediate second poll trips the slow-down rate limit
/// (`last_polled_at` is within `DEVICE_CODE_POLL_INTERVAL`).
#[tokio::test]
async fn device_grant_pending_then_slow_down() {
    let (g, _host_owner_token, db) = spin_up();
    plant_device_request(
        &store_handle(&db),
        "wildflower-host",
        "dev-pending",
        &[&WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=dev-pending";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(first.into_body()).await,
        serde_json::json!({ "error": "authorization_pending" })
    );
    let second = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(second.into_body()).await,
        serde_json::json!({ "error": "slow_down" })
    );
}

/// An approved device request mints a token exactly once: the first exchange
/// succeeds and expires the request, so a second exchange sees `expired_token`
/// (single-use, RFC 8628 §3.4).
#[tokio::test]
async fn device_grant_single_use_then_expired_token() {
    let (g, _host_owner_token, db) = spin_up();
    plant_device_request(
        &store_handle(&db),
        "wildflower-host",
        "dev-approved",
        &[&WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=dev-approved";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::OK);
    let token = body_json(first.into_body()).await;
    assert_eq!(token["token_type"], "Bearer");
    assert_eq!(
        token["scope"],
        WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()
    );

    let second = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(second.into_body()).await,
        serde_json::json!({ "error": "expired_token" })
    );
}

/// Device-flow consent clamps the granted scopes to the client's *current*
/// `allowed_scopes`, not just what the (possibly stale) request asked for: a
/// request that asked for `write` while it was permitted must not grant `write`
/// after the client's policy no longer allows it. Regression guard for the
/// device path, which previously intersected only with `requested_scopes` (the
/// code-flow path already clamped to `allowed_scopes`).
#[tokio::test]
async fn device_consent_clamps_granted_scopes_to_client_allowed() {
    let (g, host_owner_token, db) = spin_up();
    // The client currently permits only `read` — `write` is no longer allowed.
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    // A pending device request that still asks for the now-disallowed `write`.
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-clamp",
        &["read", "write"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // The Owner approves both scopes; the handler must drop `write`.
    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read","write"]}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );

    // The issued token carries only the still-allowed `read`, never `write`.
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=device-client&device_code=dev-clamp";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::OK);
    let token = body_json(res.into_body()).await;
    assert_eq!(token["scope"], "read");
}

/// Device-flow consent now threads an optional `patient` from the approve body
/// onto the approved request (the code flow already did). Locks in the one live
/// behavior change of the consent-dedup refactor: with the shared `ApproveBody`
/// the device endpoint *honors* a posted `patient`, so a device UI that selects
/// a patient binds it to the grant. The device UI doesn't send `patient` yet,
/// so this is the only test that exercises the wired-through path.
#[tokio::test]
async fn device_consent_threads_patient_onto_request() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-patient",
        &["read"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // The Owner approves and selects a patient context.
    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read"],"patient":"Patient/123"}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );

    // The posted patient is persisted onto the now-approved request.
    let request = store_handle(&db)
        .authorization_request_by_id("dev-patient")
        .expect("query request")
        .expect("request present");
    assert_eq!(request.status, RequestStatus::Approved);
    assert_eq!(request.patient.as_deref(), Some("Patient/123"));
}

/// Device-flow consent is EXPANDABLE: the Owner pairing a device may grant
/// scopes the device never requested, up to the client's `allowed_scopes`.
/// (The code-flow path stays clamped to `requested_scopes` — a third-party app
/// can't widen its own grant; see `device_consent_clamps_granted_scopes_to_client_allowed`
/// for the still-enforced allowed-scopes ceiling.)
#[tokio::test]
async fn device_consent_allows_expansion_beyond_requested() {
    let (g, host_owner_token, db) = spin_up();
    // The client is allowed both read and write.
    seed_client_with_redirect(
        &db,
        "device-client",
        "https://app.example/cb",
        &["read", "write"],
    );
    // ...but the device requested only `read`.
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-expand",
        &["read"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // The Owner grants the un-requested-but-allowed `write` on top of `read`.
    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read","write"]}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );

    // The expansion is persisted onto the grant — `write` was never requested.
    let request = store_handle(&db)
        .authorization_request_by_id("dev-expand")
        .expect("query request")
        .expect("request present");
    let granted = request.granted_scopes.expect("granted scopes");
    assert!(granted.contains(&"read".to_string()));
    assert!(granted.contains(&"write".to_string()));
}

/// The device-authorization request carries the human-chosen `device_name`
/// extension end to end: minted at `/oauth/device_authorization`, stored on the
/// request, and surfaced (alongside the client's `allowedScopes` expansion
/// envelope) on the `/access/devices/{userCode}` consent prompt.
#[tokio::test]
async fn device_authorization_carries_device_name_to_consent() {
    let (g, host_owner_token, _db) = spin_up();
    // Start the flow with a device name (URL-encoded, includes a space + apostrophe).
    let start = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from("client_id=wildflower-host&scope=system%2F*.cruds&device_name=Ada%27s%20laptop"),
    );
    let res = g.router.clone().oneshot(start).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let user_code = body_json(res.into_body()).await["user_code"]
        .as_str()
        .expect("user_code")
        .to_string();

    // The consent prompt surfaces the device name and a non-empty expansion envelope.
    let get = loopback_request(
        Request::get(format!("/access/devices/{user_code}"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.clone().oneshot(get).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let consent = body_json(res.into_body()).await;
    assert_eq!(consent["deviceName"], "Ada's laptop");
    assert!(consent["allowedScopes"]
        .as_array()
        .expect("allowedScopes array")
        .iter()
        .any(|scope| scope == "system/*.cruds"));
}

/// When a device-code client doesn't name itself, a friendly name is inferred
/// from its `User-Agent` and surfaced on the consent prompt (and later keyed on
/// by the durable grant). A browser-shaped UA becomes "Browser on OS".
#[tokio::test]
async fn device_authorization_infers_device_name_from_user_agent_when_unnamed() {
    let (g, host_owner_token, _db) = spin_up();
    // No `device_name` in the body — only a browser User-Agent.
    let start = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("user-agent", CHROME_MAC_USER_AGENT),
        Body::from("client_id=wildflower-host&scope=system%2F*.cruds"),
    );
    let res = g.router.clone().oneshot(start).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let user_code = body_json(res.into_body()).await["user_code"]
        .as_str()
        .expect("user_code")
        .to_string();

    let get = loopback_request(
        Request::get(format!("/access/devices/{user_code}"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.clone().oneshot(get).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["deviceName"],
        "Chrome on macOS"
    );
}

/// A client-supplied `device_name` is never overridden by the User-Agent
/// inference — the explicit name wins even when a recognizable UA is present.
#[tokio::test]
async fn explicit_device_name_wins_over_user_agent_inference() {
    let (g, host_owner_token, _db) = spin_up();
    let start = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("user-agent", CHROME_MAC_USER_AGENT),
        Body::from("client_id=wildflower-host&scope=system%2F*.cruds&device_name=Ada%27s%20laptop"),
    );
    let res = g.router.clone().oneshot(start).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let user_code = body_json(res.into_body()).await["user_code"]
        .as_str()
        .expect("user_code")
        .to_string();

    let get = loopback_request(
        Request::get(format!("/access/devices/{user_code}"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.clone().oneshot(get).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["deviceName"],
        "Ada's laptop"
    );
}

/// The settings approver may rename the device before approving — the adjusted
/// `deviceName` on the approve body is persisted onto the request (`COALESCE`d,
/// so an omitted name leaves the stored one intact).
#[tokio::test]
async fn device_consent_approver_can_adjust_device_name() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-rename",
        &["read"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read"],"deviceName":"Reception iPad"}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);

    let request = store_handle(&db)
        .authorization_request_by_id("dev-rename")
        .expect("query request")
        .expect("request present");
    assert_eq!(request.device_name.as_deref(), Some("Reception iPad"));
}

/// The headline behavior of this ticket: approving a device-code consent mints a
/// **durable device grant** (the record "Authorized Devices" in Settings lists),
/// and the family the device's `offline_access` token starts links back to that
/// grant. This is the device-flow half of the "family carries grant_id for both
/// flows" contract; `offline_access_issues_rotating_refresh_token` is the
/// code-flow half.
#[tokio::test]
async fn device_approval_mints_durable_grant_and_links_refresh_family() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "device-client",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-durable",
        &["read", "offline_access"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // Approve, naming the device.
    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read","offline_access"],"deviceName":"Reception iPad"}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);

    // A durable device grant now shows in the access index as the `device_code`
    // union variant, titled by its deviceName.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let grants = body_json(res.into_body()).await;
    let device_grant = grants
        .as_array()
        .expect("grants array")
        .iter()
        .find(|grant| grant["grantType"] == "device_code")
        .expect("a device grant was minted");
    assert_eq!(device_grant["deviceName"], "Reception iPad");
    assert_eq!(device_grant["clientId"], "device-client");
    let scopes = device_grant["scopes"].as_array().expect("scopes array");
    assert!(scopes.iter().any(|scope| scope == "read"));
    assert!(scopes.iter().any(|scope| scope == "offline_access"));

    // Redeeming the device_code issues the offline_access refresh token, whose
    // family links back to the device grant just minted.
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=device-client&device_code=dev-durable";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::OK);
    let refresh = body_json(res.into_body()).await["refresh_token"]
        .as_str()
        .expect("offline_access refresh token")
        .to_string();

    let (_, family) = store_handle(&db)
        .refresh_token_with_family_by_hash(&token_storage_hash(&refresh))
        .expect("family query")
        .expect("family present");
    assert_eq!(
        family.grant_id.as_deref(),
        Some(device_grant["id"].as_str().expect("grant id")),
    );
}

/// A client restricted to a grant-type subset is refused a grant outside it
/// (RFC 6749 §5.2 `unauthorized_client`). Here a code-only client is rejected
/// at the refresh-token grant before any token lookup.
#[tokio::test]
async fn token_endpoint_rejects_grant_outside_client_allow_list() {
    let (g, _host_owner_token, db) = spin_up();
    store_handle(&db)
        .upsert_client(&Client {
            client_id: "code-only".to_string(),
            name: "Code-only client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![Url::parse("https://app.example/cb").unwrap().into()],
            allowed_scopes: vec!["read".to_string(), "offline_access".to_string()],
            allowed_grant_types: vec![AllowedGrantType::AuthorizationCode],
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register code-only client");

    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=code-only&refresh_token=whatever",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await["error"],
        "unauthorized_client"
    );
}

/// RFC 6749 §5.1/§5.2 (inherited by RFC 8628 §3.4): the
/// `/oauth/device_authorization` response must suppress caching just like the
/// token endpoint — the token-endpoint case is already covered, this pins the
/// device endpoint.
#[tokio::test]
async fn device_authorization_sets_cache_suppression_headers() {
    let (g, _host_owner_token, _db) = spin_up();
    let res = post_form(
        &g.router,
        "/oauth/device_authorization",
        "client_id=wildflower-host&scope=system%2F*.cruds",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    assert_eq!(
        res.headers().get("pragma").map(|v| v.to_str().unwrap()),
        Some("no-cache")
    );
}

/// Granting `offline_access` issues a rotating refresh token, and the full
/// rotation contract holds: redeeming swaps generations, replaying a consumed
/// generation revokes the whole family (OAuth 2.1 rotation semantics), so the
/// rotated-to token dies with it.
#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn offline_access_issues_rotating_refresh_token() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    let request_id = authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read%20offline_access",
        r#"{"approvedScopes":["read","offline_access"]}"#,
    )
    .await;

    // Pull the redeemable code off the status poll, then redeem it.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let status = body_json(res.into_body()).await;
    let redirect = status["redirect"].as_str().expect("redirect");
    let code = Url::parse(redirect)
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");
    let body = format!(
        "grant_type=authorization_code&client_id=test-app&code={code}&\
         code_verifier={CODE_VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"
    );
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let token = body_json(res.into_body()).await;
    assert_eq!(token["scope"], "read offline_access");
    let first_refresh = token["refresh_token"]
        .as_str()
        .expect("refresh_token present with offline_access")
        .to_string();

    // The minted family records the authorization-code grant that authorized it
    // — write-only plumbing for a future per-device revoke. This is the
    // code-flow half of the "family carries grant_id for both flows" contract.
    {
        let store = store_handle(&db);
        let grant = store
            .grant_by_client_and_redirect(
                "test-app",
                &Url::parse("https://app.example/cb").unwrap(),
            )
            .expect("grant query")
            .expect("code grant minted at approval");
        let (_, family) = store
            .refresh_token_with_family_by_hash(&token_storage_hash(&first_refresh))
            .expect("family query")
            .expect("family present");
        assert_eq!(family.grant_id.as_deref(), Some(grant.id.as_str()));
    }

    // Redeem the refresh token: fresh access token + the next generation.
    let body = format!("grant_type=refresh_token&client_id=test-app&refresh_token={first_refresh}");
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body.clone()),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let refreshed = body_json(res.into_body()).await;
    assert_eq!(refreshed["token_type"], "Bearer");
    assert_eq!(refreshed["scope"], "read offline_access");
    assert!(!refreshed["access_token"]
        .as_str()
        .expect("access_token")
        .is_empty());
    let second_refresh = refreshed["refresh_token"]
        .as_str()
        .expect("rotated refresh_token")
        .to_string();
    assert_ne!(second_refresh, first_refresh);

    // Replaying the consumed generation is treated as theft …
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has been revoked",
        })
    );

    // … which kills the whole family: the rotated-to token is dead too. The
    // family is expired in place (not deleted), so it reports as expired.
    let body =
        format!("grant_type=refresh_token&client_id=test-app&refresh_token={second_refresh}");
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has expired",
        })
    );
}

/// A refresh token past its family's absolute deadline is `invalid_grant`.
/// The rows survive the attempt — natural deadline passage writes nothing.
#[tokio::test]
async fn expired_refresh_token_family_is_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    let store = store_handle(&db);
    plant_refresh_token(
        &store,
        "stale-token",
        "test-app",
        Utc::now() - Duration::days(1),
    );

    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=test-app&refresh_token=stale-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has expired",
        })
    );
    let (row, _family) = store
        .refresh_token_with_family_by_hash(&token_storage_hash("stale-token"))
        .expect("query")
        .expect("row kept");
    assert_eq!(row.consumed_at, None);
}

/// A refresh token presented by a different registered client is rejected
/// exactly like an unknown token (RFC 6749 §6 client binding) — and the
/// mismatch does NOT revoke the rightful owner's family.
#[tokio::test]
async fn refresh_token_is_bound_to_issuing_client() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "owner-app", "https://app.example/cb", &["read"]);
    seed_client_with_redirect(&db, "other-app", "https://other.example/cb", &["read"]);
    let store = store_handle(&db);
    plant_refresh_token(
        &store,
        "owned-token",
        "owner-app",
        Utc::now() + Duration::days(30),
    );

    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=other-app&refresh_token=owned-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid refresh_token parameter",
        })
    );
    // The rightful owner's token is untouched — still live.
    let (row, _family) = store
        .refresh_token_with_family_by_hash(&token_storage_hash("owned-token"))
        .expect("query")
        .expect("row present");
    assert_eq!(row.consumed_at, None);
}

/// Revoking a grant on the Owner surface also kills the client's refresh
/// tokens — standing consent and standing credentials die together.
#[tokio::test]
async fn revoking_grant_revokes_refresh_tokens() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"]}"#,
    )
    .await;
    let store = store_handle(&db);
    plant_refresh_token(
        &store,
        "standing-token",
        "test-app",
        Utc::now() + Duration::days(30),
    );

    // Find the grant id on the Owner surface, then revoke it.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    let grants = body_json(res.into_body()).await;
    let grant_id = grants[0]["id"].as_str().expect("grant id").to_string();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::delete(format!("/access/grants/{grant_id}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // Soft-revoked: the rows survive for audit, but the family's deadline is
    // pulled back and the live token is stamped consumed — and redeeming it
    // reports the family as expired.
    let (token, family) = store
        .refresh_token_with_family_by_hash(&token_storage_hash("standing-token"))
        .expect("query")
        .expect("rows kept");
    assert!(family.expires_at <= Utc::now());
    assert!(token.consumed_at.is_some());
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=test-app&refresh_token=standing-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has expired",
        })
    );
}
