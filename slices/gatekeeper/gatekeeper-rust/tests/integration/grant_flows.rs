use crate::common::*;

/// Drive the full auth-code grant: `/authorize` → owner consent approve →
/// status poll → `/token`. The core happy path; nothing else here exercises it
/// end-to-end. Asserts a signed bearer token comes back with the granted scope.
#[tokio::test]
async fn auth_code_grant_happy_path_end_to_end() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let challenge = compute_code_challenge(CODE_VERIFIER);

    // 1. /authorize parks a pending request and 302s to the owner polling page.
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    );
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let polling = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location")
        .to_string();
    let request_id = polling.rsplit('/').next().expect("request id").to_string();

    // 2. Owner approves the requested scope via the consent endpoint.
    let approve = loopback_request(
        Request::post(format!("/access/oauth-consents/{request_id}/approve"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read"],"acknowledgedRegistration":false}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    // The approve response's inline-completion redirect must target the client's
    // `redirect_uri` and carry both the redeemable `code` and the client's `state`.
    let approve_body = body_json(res.into_body()).await;
    assert_eq!(approve_body["status"], "approved");
    let approve_redirect = approve_body["redirect"].as_str().expect("approve redirect");
    assert!(
        approve_redirect.starts_with("https://app.example/cb"),
        "approve redirect should target the client redirect_uri, got {approve_redirect}"
    );
    let (approve_code, approve_state) = {
        let url = Url::parse(approve_redirect).expect("approve redirect url");
        let code = url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned())
            .expect("approve code param");
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned())
            .expect("approve state param");
        (code, state)
    };
    assert_eq!(approve_state, "xyz");

    // 3. The status poll now reports Approved and hands back the client
    //    redirect carrying the redeemable `code`. It must agree with the code
    //    the approve response already returned.
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
    assert_eq!(status["status"], "approved");
    let redirect = status["redirect"].as_str().expect("redirect");
    let code = Url::parse(redirect)
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");
    assert_eq!(
        code, approve_code,
        "approve-response code and poll code must agree"
    );

    // 4. /token redeems the code with the matching PKCE verifier.
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
    assert_eq!(token["token_type"], "Bearer");
    assert_eq!(token["scope"], "read");
    assert!(!token["access_token"]
        .as_str()
        .expect("access_token")
        .is_empty());
    // No `offline_access` in the grant → no standing credential.
    assert!(token.get("refresh_token").is_none());
}

/// `GET /oauth-consents/{id}` names the app: alongside the raw `clientId`,
/// the payload carries the registered client's display name so the consent UI
/// can lead with something a patient can recognize.
#[tokio::test]
async fn oauth_consent_prompt_carries_client_display_name() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let challenge = compute_code_challenge(CODE_VERIFIER);

    // /authorize parks a pending request the Owner UI would then load.
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    );
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let polling = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location")
        .to_string();
    let request_id = polling.rsplit('/').next().expect("request id").to_string();

    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/access/oauth-consents/{request_id}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let consent = body_json(res.into_body()).await;
    assert_eq!(consent["clientId"], "test-app");
    assert_eq!(consent["clientName"], "Integration Test Client");
}

/// The Owner may *narrow* a requested scope at consent time: a request for
/// `patient/Observation.rs` approved as the tighter `patient/Observation.s` is
/// still ⊆ the request, so `grantable_scopes` keeps it (coverage, not exact
/// equality). The flow must approve — not deny — and the minted token must
/// carry the narrowed `patient/Observation.s`. Guards the covers-based
/// `is_requested` change in `scopes_rust::grantable_scopes`.
#[tokio::test]
async fn auth_code_grant_owner_narrows_requested_scope() {
    let (g, host_owner_token, db) = spin_up();
    // The client is allowed the broader `.rs`; the request asks for `.rs`.
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs"],
    );
    let challenge = compute_code_challenge(CODE_VERIFIER);

    // 1. /authorize parks a pending request for `patient/Observation.rs`.
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&\
         scope=patient%2FObservation.rs&code_challenge={challenge}&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    );
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let polling = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location")
        .to_string();
    let request_id = polling.rsplit('/').next().expect("request id").to_string();

    // 2. Owner approves the *narrowed* `.s` — tighter than the requested `.rs`.
    let approve = loopback_request(
        Request::post(format!("/access/oauth-consents/{request_id}/approve"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(
            r#"{"approvedScopes":["patient/Observation.s"],"acknowledgedRegistration":false}"#,
        ),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    // Approved (NOT denied): the narrowed scope is covered by the request.
    let approve_body = body_json(res.into_body()).await;
    assert_eq!(approve_body["status"], "approved");
    let code = Url::parse(approve_body["redirect"].as_str().expect("redirect"))
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");

    // 3. /token redeems the code; the grant carries the narrowed `.s`.
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
    assert_eq!(token["scope"], "patient/Observation.s");
}

/// HFS authorizes FHIR reads off the token's `scope` claim, parsing only the
/// SMART v2 letter grammar — so a v1-worded grant must be minted with its
/// letter-form alternate alongside it. The app-facing `TokenResponse.scope`
/// stays the granted set verbatim.
#[tokio::test]
async fn minted_jwt_scope_claim_carries_alternate_canonical_forms() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.read"],
    );
    let request_id = authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "patient%2FObservation.read",
        r#"{"approvedScopes":["patient/Observation.read"],"acknowledgedRegistration":false}"#,
    )
    .await;

    // Poll the approved request for the client redirect carrying the code.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    let status = body_json(res.into_body()).await;
    let redirect = status["redirect"].as_str().expect("redirect");
    let code = Url::parse(redirect)
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");

    // Redeem the code for a token.
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

    // App-facing `scope` is the granted set, unexpanded.
    assert_eq!(token["scope"], "patient/Observation.read");

    // The signed JWT carries both the v1 word and its v2 letter twin.
    let access_token = token["access_token"].as_str().expect("access_token");
    let claims = decode_jwt_payload(access_token);
    let scope_claim = claims["scope"].as_str().expect("scope claim");
    let claim_scopes: Vec<&str> = scope_claim.split_whitespace().collect();
    assert!(
        claim_scopes.contains(&"patient/Observation.read")
            && claim_scopes.contains(&"patient/Observation.rs"),
        "JWT scope claim must carry both v1 and v2 forms, got {scope_claim:?}"
    );
}

/// Consent approval persists a `Grant` row visible on the Owner surface —
/// the standing-consent record that powers the `/authorize` fast path.
#[tokio::test]
async fn consent_approval_persists_grant() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":false}"#,
    )
    .await;

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
    let body = body_json(res.into_body()).await;
    // `id` and `grantedAt` are runtime-generated; thread them through and
    // pin everything else by comparing the whole body against one literal.
    let id = body[0]["id"].clone();
    let granted_at = body[0]["grantedAt"].clone();
    assert_eq!(
        body,
        serde_json::json!([{
            "id": id,
            "clientId": "test-app",
            "scopes": ["read"],
            "grantType": "authorization_code",
            "redirectUri": "https://app.example/cb",
            "grantedAt": granted_at,
            "lastUsedAt": null,
            "patient": null,
        }])
    );
}

/// Once a grant covers every requested scope, re-authorizing skips the Owner
/// UI entirely: `/authorize` 302s straight back to the client with a fresh
/// `code` (RFC 6749 §4.1 — a previously established authorization decision).
#[tokio::test]
async fn pre_approved_scopes_skip_consent_on_reauthorize() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":false}"#,
    )
    .await;

    let challenge = compute_code_challenge(CODE_VERIFIER);
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=second"
    );
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location");
    // Straight back to the client — not the polling page.
    let url = Url::parse(location).expect("location url");
    assert_eq!(
        url.as_str().split('?').next(),
        Some("https://app.example/cb")
    );
    let code = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");
    assert!(!code.is_empty());
    assert!(url
        .query_pairs()
        .any(|(k, v)| k == "state" && v == "second"));
}

/// Approvals union into the standing grant: consenting to `write` later must
/// not un-approve the previously consented `read`.
#[tokio::test]
async fn consent_approvals_union_scopes_into_grant() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "write"],
    );
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":false}"#,
    )
    .await;
    // Second request asks for both, but the Owner only approves `write` —
    // the grant must still cover both afterwards.
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read%20write",
        r#"{"approvedScopes":["write"],"acknowledgedRegistration":false}"#,
    )
    .await;

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
    let body = body_json(res.into_body()).await;
    assert_eq!(body[0]["scopes"], serde_json::json!(["read", "write"]));
    // The code-flow grant serializes as the `authorization_code` variant of the
    // grantType-tagged union, carrying its redirectUri.
    assert_eq!(body[0]["grantType"], "authorization_code");
    assert_eq!(body[0]["redirectUri"], "https://app.example/cb");
    assert_eq!(body.as_array().map(Vec::len), Some(1), "body = {body}");
}

/// Redeeming with a verifier that doesn't hash to the stored challenge is an
/// `invalid_grant` PKCE failure (RFC 7636 §4.6 / RFC 6749 §5.2).
#[tokio::test]
async fn auth_code_grant_wrong_verifier_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&db),
        "test-app",
        &redirect,
        &["read"],
        "good-code",
        Utc::now() + Duration::minutes(1),
    );
    // A well-formed (length-valid) but wrong verifier reaches the PKCE check.
    let body = "grant_type=authorization_code&client_id=test-app&code=good-code&\
                code_verifier=wrongwrongwrongwrongwrongwrongwrongwrongwro&\
                redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid authorization grant",
        })
    );
}

/// A code past its `expires_at` is rejected as `invalid_grant` even with the
/// correct verifier (RFC 6749 §4.1.2 short-lived codes). Forced via a
/// store-level insert of an already-expired row rather than a real-time sleep.
#[tokio::test]
async fn auth_code_grant_expired_code_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&db),
        "test-app",
        &redirect,
        &["read"],
        "stale-code",
        Utc::now() - Duration::seconds(1),
    );
    let body = "grant_type=authorization_code&client_id=test-app&code=stale-code&\
                code_verifier=verifierverifierverifierverifierverifierabc&\
                redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid authorization grant",
        })
    );
}

/// A code is single-use: the first `/token` redemption succeeds, the second
/// (with the same code) fails — the code is consumed atomically on redeem
/// (RFC 6749 §10.5).
#[tokio::test]
async fn auth_code_grant_replay_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&db),
        "test-app",
        &redirect,
        &["read"],
        "once-code",
        Utc::now() + Duration::minutes(1),
    );
    let body = "grant_type=authorization_code&client_id=test-app&code=once-code&\
                code_verifier=verifierverifierverifierverifierverifierabc&\
                redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::OK);
    let second = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(second.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid authorization grant",
        })
    );
}

/// Replaying a consumed authorization code revokes the refresh-token family it
/// minted (RFC 6749 §4.1.2 / OAuth 2.1 §4.1.2.1): the first redemption returns
/// a rotating refresh token; replaying the same code is rejected AND kills that
/// lineage, so the previously-issued refresh token can no longer be rotated.
#[tokio::test]
async fn auth_code_replay_revokes_issued_refresh_family() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    plant_authorization_code(
        &store_handle(&db),
        "test-app",
        &Url::parse("https://app.example/cb").unwrap(),
        &["read", "offline_access"],
        "reuse-code",
        Utc::now() + Duration::minutes(1),
    );
    let redeem = "grant_type=authorization_code&client_id=test-app&code=reuse-code&\
                  code_verifier=verifierverifierverifierverifierverifierabc&\
                  redirect_uri=https%3A%2F%2Fapp.example%2Fcb";

    // First redemption succeeds and hands back a rotating refresh token.
    let first = post_form(&g.router, "/oauth/token", redeem).await;
    assert_eq!(first.status(), StatusCode::OK);
    let refresh_token = body_json(first.into_body())
        .await
        .get("refresh_token")
        .and_then(Value::as_str)
        .expect("refresh_token issued with offline_access")
        .to_string();

    // Replaying the same code is rejected.
    let replay = post_form(&g.router, "/oauth/token", redeem).await;
    assert_eq!(replay.status(), StatusCode::BAD_REQUEST);

    // The refresh token from the first redemption is now revoked — rotating it
    // fails because the replay killed its family.
    let rotate_req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(format!(
            "grant_type=refresh_token&client_id=test-app&refresh_token={refresh_token}"
        )),
    );
    let rotate = g.router.clone().oneshot(rotate_req).await.expect("oneshot");
    assert_eq!(rotate.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(rotate.into_body()).await["error"],
        "invalid_grant"
    );
}

// ---------------------------------------------------------------------------
// Trust on first use: an app the gatekeeper has never seen (or one whose
// request steps outside its registration) reaches the Owner's prompt with a
// warning, and the `clients` row is created or widened only on approval.
// ---------------------------------------------------------------------------

/// The consent prompt carries the registration verdict, recomputed from the
/// current row: `registered` for a request that matches the registration, `new`
/// for a client with no row at all.
#[tokio::test]
async fn consent_prompt_reports_the_registration_verdict() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);

    let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
    let known = parked_request_id(&res);
    let consent = get_oauth_consent(&g, &host_owner_token, &known).await;
    assert_eq!(
        consent["registration"],
        serde_json::json!({ "status": "registered" })
    );

    let res = get_authorize(&g.router, &authorize_query("brand-new-app", "read")).await;
    let unknown = parked_request_id(&res);
    let consent = get_oauth_consent(&g, &host_owner_token, &unknown).await;
    assert_eq!(
        consent["registration"],
        serde_json::json!({"status": "new"})
    );
    // A client with no row is still named on the prompt — by its `client_id`.
    assert_eq!(consent["clientName"], "brand-new-app");
}

/// Approving a `new` app without acknowledging the warning is rejected with a
/// structured `409`, and writes nothing: no client row, no grant, no code — and
/// the prompt is still pending, so the Owner can decide again.
#[tokio::test]
async fn approving_a_new_app_without_acknowledgement_is_rejected() {
    let (g, host_owner_token, db) = spin_up();
    let res = get_authorize(&g.router, &authorize_query("brand-new-app", "read")).await;
    let request_id = parked_request_id(&res);

    let res = approve_oauth_consent(
        &g,
        &host_owner_token,
        &request_id,
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":false}"#.to_string(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "RegistrationNotAcknowledged",
            "id": request_id,
        }),
    );

    let store = store_handle(&db);
    assert!(store.client_by_id("brand-new-app").unwrap().is_none());
    assert!(store
        .grant_by_client_and_redirect(
            "brand-new-app",
            &Url::parse("https://app.example/cb").unwrap(),
        )
        .unwrap()
        .is_none());
    assert!(store
        .authorization_code_by_request_id(&request_id)
        .unwrap()
        .is_none());
    // Still pending — the prompt loads again.
    let consent = get_oauth_consent(&g, &host_owner_token, &request_id).await;
    assert_eq!(
        consent["registration"],
        serde_json::json!({"status": "new"})
    );
}

/// The whole trust-on-first-use loop: an acknowledged approval registers the app
/// (public client, named by its id, the one redirect it used, the granted
/// scopes), issues the code, and leaves a standing grant — so the *same* request
/// a moment later is `registered` and takes the fast path straight back to the
/// client.
#[tokio::test]
async fn approving_a_new_app_registers_it_and_the_next_request_fast_paths() {
    let (g, host_owner_token, db) = spin_up();
    let res = get_authorize(&g.router, &authorize_query("brand-new-app", "read")).await;
    let request_id = parked_request_id(&res);

    let res = approve_oauth_consent(
        &g,
        &host_owner_token,
        &request_id,
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":true}"#.to_string(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let approved = body_json(res.into_body()).await;
    assert_eq!(approved["status"], "approved");
    assert!(approved["redirect"]
        .as_str()
        .expect("approve redirect")
        .starts_with("https://app.example/cb?code="));

    let store = store_handle(&db);
    let registered = store
        .client_by_id("brand-new-app")
        .unwrap()
        .expect("the approval registers the client");
    assert_eq!(registered.name, "brand-new-app");
    assert_eq!(registered.kind, ClientKind::Public);
    assert_eq!(
        registered.redirect_uris,
        vec![Url::parse("https://app.example/cb").unwrap().into()],
    );
    assert_eq!(registered.allowed_scopes, vec!["read".to_string()]);
    assert_eq!(
        registered.allowed_grant_types,
        AllowedGrantType::ALL.to_vec()
    );
    assert!(registered.secret_hash.is_none());
    assert!(registered.disabled_at.is_none());
    assert!(store
        .grant_by_client_and_redirect(
            "brand-new-app",
            &Url::parse("https://app.example/cb").unwrap(),
        )
        .unwrap()
        .is_some());

    // Same client, same redirect, same scopes → `registered`, so the standing
    // grant pre-approves everything and `/authorize` 302s straight back.
    let res = get_authorize(&g.router, &authorize_query("brand-new-app", "read")).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = location_of(&res);
    assert!(
        location.starts_with("https://app.example/cb?code="),
        "the second request must fast-path back to the client, got {location}"
    );
}

/// Approving a known client's `changed` request widens its registration in
/// place: the new redirect is appended to the existing allowlist, the granted
/// scopes are unioned, a requested-but-pruned scope is NOT added, and the row's
/// identity (`registered_at`, name) survives.
#[tokio::test]
async fn approving_a_changed_app_widens_its_registration() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://elsewhere.example/cb", &["read"]);
    let store = store_handle(&db);
    let before = store.client_by_id("test-app").unwrap().unwrap();

    // A different redirect AND two scopes the registration doesn't cover.
    let res = get_authorize(
        &g.router,
        &authorize_query("test-app", "read%20write%20pruned"),
    )
    .await;
    let request_id = parked_request_id(&res);
    let consent = get_oauth_consent(&g, &host_owner_token, &request_id).await;
    assert_eq!(
        consent["registration"],
        serde_json::json!({
            "status": "changed",
            "redirectUriIsNew": true,
            "newScopes": ["write", "pruned"],
        }),
    );

    let res = approve_oauth_consent(
        &g,
        &host_owner_token,
        &request_id,
        r#"{"approvedScopes":["read","write"],"acknowledgedRegistration":true}"#.to_string(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let after = store.client_by_id("test-app").unwrap().unwrap();
    assert_eq!(
        after.redirect_uris,
        vec![
            Url::parse("https://elsewhere.example/cb").unwrap().into(),
            Url::parse("https://app.example/cb").unwrap().into(),
        ],
    );
    // `pruned` was requested but not granted, so it is not registered.
    assert_eq!(
        after.allowed_scopes,
        vec!["read".to_string(), "write".to_string()],
    );
    assert_eq!(after.name, before.name);
    assert_eq!(after.registered_at, before.registered_at);
}

/// Denying a `new` app leaves nothing behind — the row is created on approval
/// only.
#[tokio::test]
async fn denying_a_new_app_registers_nothing() {
    let (g, host_owner_token, db) = spin_up();
    let res = get_authorize(&g.router, &authorize_query("brand-new-app", "read")).await;
    let request_id = parked_request_id(&res);

    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post(format!("/access/oauth-consents/{request_id}/deny"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "denied");
    assert!(store_handle(&db)
        .client_by_id("brand-new-app")
        .unwrap()
        .is_none());
}

/// The fast path is gated on the verdict, not on grant coverage alone: once the
/// registration no longer covers the request, a standing grant that *does* cover
/// every requested scope must NOT skip the Owner — they have not seen this
/// combination.
#[tokio::test]
async fn a_changed_request_never_takes_the_fast_path() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":false}"#,
    )
    .await;

    // The grant now covers `read`; narrow the registration out from under it.
    let store = store_handle(&db);
    let mut client = store.client_by_id("test-app").unwrap().unwrap();
    client.allowed_scopes = Vec::new();
    store.upsert_client(&client).expect("narrow the client");

    let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
    let request_id = parked_request_id(&res);
    let consent = get_oauth_consent(&g, &host_owner_token, &request_id).await;
    assert_eq!(consent["registration"]["status"], "changed");
    // The pre-approved set is empty too: a changed request is presented fresh.
    assert_eq!(
        consent["preApprovedScopes"],
        serde_json::json!([] as [&str; 0])
    );
}
