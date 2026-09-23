use crate::common::*;

/// Trust on first use: a `client_id` this gatekeeper has never seen is no longer
/// rejected at the door. Its request is parked like any other and the browser is
/// sent to the Owner's prompt — and **nothing** is written to the `clients`
/// table, so a request nobody approves leaves no trace of the app.
#[tokio::test]
async fn authorize_unknown_client_parks_a_pending_request() {
    let (g, _host_owner_token, db) = spin_up();
    let res = get_authorize(&g.router, &authorize_query("ghost", "read")).await;
    let request_id = parked_request_id(&res);

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
    assert_eq!(body_json(res.into_body()).await["status"], "pending");
    assert!(
        store_handle(&db)
            .client_by_id("ghost")
            .expect("client query")
            .is_none(),
        "/authorize must not register an unknown client",
    );
}

/// The redirect of an unknown client is untrusted, so a later validation failure
/// may NOT be 302'd to it (RFC 6749 §4.1.2.1's open-redirect rule): a malformed
/// PKCE challenge and a non-`code` `response_type` both render the local HTML
/// page instead.
/// The polling redirect names the request's served origin as `?server=`, so the
/// hosted owner UI polls the server the browser actually reached: loopback for a
/// direct caller, the forwarded public origin for one relayed through the front.
#[tokio::test]
async fn polling_redirect_names_the_served_origin() {
    let (g, _host_owner_token, _db) = spin_up();
    let server_of = |res: &axum::response::Response| {
        let url = Url::parse(&location_of(res)).expect("absolute polling URL");
        url.query_pairs()
            .find(|(key, _)| key == "server")
            .map(|(_, value)| value.into_owned())
    };

    let direct = get_authorize(&g.router, &authorize_query("ghost", "read")).await;
    assert_eq!(server_of(&direct).as_deref(), Some(LOOPBACK_ORIGIN));

    let forwarded = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!(
                "/oauth/authorize?{}",
                authorize_query("ghost", "read")
            ))
            .header(
                "forwarded",
                "host=ruth.wildflowerhealth.example;proto=https",
            ),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(
        server_of(&forwarded).as_deref(),
        Some("https://ruth.wildflowerhealth.example")
    );
}

#[tokio::test]
async fn authorize_unknown_client_renders_later_failures_locally() {
    let (g, _host_owner_token, _db) = spin_up();
    let challenge = compute_code_challenge(CODE_VERIFIER);
    for (query, expected) in [
        (
            "response_type=code&code_challenge_method=S256&client_id=ghost&scope=read&\
             code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
                .to_string(),
            "Invalid PKCE code challenge",
        ),
        (
            "response_type=code&code_challenge_method=plain&client_id=ghost&scope=read&\
             code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
                .to_string(),
            "Unsupported PKCE method",
        ),
        (
            format!(
                "response_type=token&code_challenge_method=S256&client_id=ghost&scope=read&\
                 code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
            ),
            "Unsupported response type",
        ),
    ] {
        let res = get_authorize(&g.router, &query).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "query = {query}");
        let body = body_string(res.into_body()).await;
        assert!(body.contains(expected), "body = {body}");
    }
}

/// A **known** client presenting a redirect it never registered is treated the
/// same way: the request is parked for the Owner, and until they approve that
/// redirect is untrusted, so a bad PKCE challenge renders locally rather than
/// 302ing to it.
#[tokio::test]
async fn authorize_unregistered_redirect_parks_and_keeps_the_redirect_untrusted() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://elsewhere.example/cb", &["read"]);
    let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
    parked_request_id(&res);

    let query = "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let res = get_authorize(&g.router, query).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(
        body.contains("Invalid PKCE code challenge"),
        "body = {body}"
    );
}

/// A disabled client is rejected on every endpoint, verdict or no verdict — the
/// one client-level rejection trust-on-first-use does not relax.
#[tokio::test]
async fn authorize_disabled_client_is_still_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    // Inserted disabled: `upsert_client` deliberately preserves `disabled_at`,
    // so the flag has to be set on the row's first write.
    store_handle(&db)
        .upsert_client(&Client {
            client_id: "test-app".to_string(),
            name: "Disabled Test Client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![Url::parse("https://app.example/cb").unwrap().into()],
            allowed_scopes: vec!["read".to_string()],
            allowed_grant_types: AllowedGrantType::ALL.to_vec(),
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: Some(Utc::now()),
        })
        .expect("register a disabled client");

    let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(body.contains("Disabled client"), "body = {body}");
}

#[tokio::test]
async fn authorize_validates_redirect_uri_before_pkce_method() {
    // RFC 6749 §4.1.2.1: client_id/redirect_uri must be validated *before*
    // any redirectable error (scope/PKCE-method), since those failures get
    // 302'd back to the validated redirect_uri. The seeded `wildflower-host`
    // client has an empty redirect_uri allowlist, so even with an unsupported
    // `code_challenge_method=plain` the request fails at redirect-uri
    // validation and renders the local "Redirect URI not allowed" page rather
    // than redirecting. (The redirect-path tests below seed a client with an
    // allowlisted redirect_uri via `seed_client_with_redirect`.)
    let (g, _host_owner_token, _db) = spin_up();
    let query =
        "response_type=code&code_challenge_method=plain&client_id=wildflower-host&scope=owner&\
                 code_challenge=abc&redirect_uri=http%3A%2F%2Fexample.com%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(body.contains("Redirect URI not allowed"), "body = {body}");
}

#[tokio::test]
async fn authorize_unsupported_response_type_redirects_back() {
    // `unsupported_response_type` is a *redirectable* error (RFC 6749
    // §4.1.2.1): once client_id + redirect_uri validate, the failure goes
    // back to the client as `error` + `state` query params, not a local page.
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=token&code_challenge_method=S256&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=unsupported_response_type&state=xyz"
    );
}

#[tokio::test]
async fn authorize_unsupported_pkce_method_redirects_invalid_request() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=code&code_challenge_method=plain&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=invalid_request&state=xyz"
    );
}

/// A scope outside a (non-first-party) client's registration no longer fails the
/// request: it is carried to the Owner's prompt as a `changed` registration
/// naming exactly the scopes that stepped outside. The registered redirect stays
/// trusted, so a *different* failure on the same request still 302s back (see
/// `authorize_unsupported_pkce_method_redirects_invalid_request`).
#[tokio::test]
async fn authorize_disallowed_scope_parks_a_pending_request() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let res = get_authorize(&g.router, &authorize_query("test-app", "read%20write")).await;
    let request_id = parked_request_id(&res);

    let consent = get_oauth_consent(&g, &host_owner_token, &request_id).await;
    assert_eq!(
        consent["registration"],
        serde_json::json!({
            "status": "changed",
            "redirectUriIsNew": false,
            "newScopes": ["write"],
        }),
    );
}

/// A parked `/authorize` request must reach the host's consent popup, not only
/// the polling page. The polling page tells an unauthenticated viewer to
/// "approve this request on your device"; if the request never joins the
/// pending-consent queue, that prompt never appears and the flow hangs until the
/// 5-minute TTL — the bug this covers.
#[tokio::test]
async fn authorize_publishes_the_parked_request_as_the_consent_head() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    assert_eq!(
        pending_consent_head(&db),
        None,
        "no request has been parked yet"
    );

    let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
    let request_id = parked_request_id(&res);

    assert_eq!(
        pending_consent_head(&db),
        Some(PendingConsentHead::OAuth {
            id: request_id.clone()
        }),
        "the popup must be showing the request the browser was just parked on",
    );
}

/// Deciding a parked request clears the popup: the Owner answered it, so the
/// head must not linger on a request that is no longer pending. Covers approve
/// and deny separately — they take different paths to the same republish.
#[tokio::test]
async fn deciding_an_oauth_consent_clears_the_consent_head() {
    for decision in ["approve", "deny"] {
        let (g, host_owner_token, db) = spin_up();
        seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
        let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
        let request_id = parked_request_id(&res);
        assert!(
            pending_consent_head(&db).is_some(),
            "{decision}: the request should be the popup head before it is decided",
        );

        let res = g
            .router
            .clone()
            .oneshot(loopback_request(
                Request::post(format!("/access/oauth-consents/{request_id}/{decision}"))
                    .header("host", "127.0.0.1")
                    .header("authorization", format!("Bearer {host_owner_token}"))
                    .header("content-type", "application/json"),
                Body::from(r#"{"approvedScopes":["read"],"acknowledgedRegistration":true}"#),
            ))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK, "{decision} should succeed");

        assert_eq!(
            pending_consent_head(&db),
            None,
            "{decision}: the popup must close once the request is decided",
        );
    }
}

/// The grant fast path approves inside `/authorize` itself, so its request is
/// never awaiting a human — it must not raise the popup on its way through
/// `pending`. A spurious popup here would ask the Owner to re-approve something
/// they already consented to, on a request that is already `approved`.
#[tokio::test]
async fn a_fast_pathed_authorize_never_becomes_the_consent_head() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    // First pass: park, approve, and so establish the standing grant.
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":true}"#,
    )
    .await;
    assert_eq!(
        pending_consent_head(&db),
        None,
        "the approved first request left the popup closed"
    );

    // Second pass: the grant now pre-approves every requested scope, so
    // /authorize issues a code and 302s straight back to the client.
    let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = location_of(&res);
    assert!(
        location.starts_with("https://app.example/cb?code="),
        "expected the fast path's client redirect, got {location}"
    );
    assert_eq!(
        pending_consent_head(&db),
        None,
        "a fully pre-approved request must never raise the consent popup",
    );
}

/// The first-party host is NOT trusted on first use: an unregistered scope for
/// `wildflower-host` is still the `invalid_scope` redirect back to its
/// (registered) redirect_uri, exactly as before.
#[tokio::test]
async fn authorize_first_party_disallowed_scope_still_redirects_invalid_scope() {
    let (g, _host_owner_token, db) = spin_up();
    // Give the host client a redirect so the request reaches the scope check.
    let store = store_handle(&db);
    let mut host = store
        .client_by_id("wildflower-host")
        .unwrap()
        .expect("the seeded first-party client");
    host.redirect_uris = vec![Url::parse("https://app.example/cb").unwrap().into()];
    store.upsert_client(&host).expect("allowlist a redirect");

    let res = get_authorize(
        &g.router,
        &authorize_query("wildflower-host", "definitely_not_granted"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(
        location_of(&res),
        "https://app.example/cb?error=invalid_scope&state=xyz"
    );
}

#[tokio::test]
async fn authorize_allows_scope_covered_by_a_broader_allowed_scope() {
    // The allowlist check is coverage-aware, not exact string membership: a
    // client allowed `patient/Observation.rs` also admits a request for the
    // narrower `patient/Observation.r` it covers — parking a pending request
    // like any allowed scope (no `error=` redirect back to the client).
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs"],
    );
    let challenge = compute_code_challenge(CODE_VERIFIER);
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&\
         scope=patient%2FObservation.r&code_challenge={challenge}&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    );
    let res = g
        .router
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
    assert!(
        !location.contains("error="),
        "a covered scope must not trigger an error redirect, got {location}"
    );
}

#[tokio::test]
async fn authorize_treats_a_cross_grammar_scope_request_as_new() {
    // Deliberate decision: coverage never bridges the SMART v1 word and v2
    // letter grammars (mirroring scopes-core). A client registered with the v1
    // `patient/Observation.read` does NOT cover a request for the
    // letter-equivalent `patient/Observation.rs` — v1 apps request v1 scopes.
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.read"],
    );
    let challenge = compute_code_challenge(CODE_VERIFIER);
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&\
         scope=patient%2FObservation.rs&code_challenge={challenge}&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    );
    let res = get_authorize(&g.router, &query).await;
    // Not covered → not `registered`; the request is parked for the Owner rather
    // than rejected, and the prompt names the uncovered spelling.
    let request_id = parked_request_id(&res);
    let consent = get_oauth_consent(&g, &host_owner_token, &request_id).await;
    assert_eq!(
        consent["registration"]["newScopes"],
        serde_json::json!(["patient/Observation.rs"]),
    );
}

#[tokio::test]
async fn authorize_accepts_smart_launch_and_aud_params() {
    // SMART App Launch forwards `launch` (the EHR-minted nonce) and `aud`
    // (the FHIR base URL the app expects) alongside the standard authorize
    // params. They're optional (`#[serde(default)]`) and not validated today,
    // so a request carrying them must validate exactly like one without them:
    // park a pending request and 302 to the owner polling page — never an
    // `error=` redirect back to the client.
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let challenge = compute_code_challenge(CODE_VERIFIER);

    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz&\
         launch=ehr-launch-nonce-123&aud=https%3A%2F%2Fapp.example%2Ffhir-r4"
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
    assert!(
        !polling.contains("error="),
        "launch/aud must not trigger an error redirect, got {polling}"
    );

    // The pending request was actually parked: polling it reports `pending`
    // (the owner hasn't approved yet), proving the SMART params didn't divert
    // or reject the flow.
    let request_id = polling_request_id(&polling);
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
    assert_eq!(body_json(res.into_body()).await["status"], "pending");
}

#[tokio::test]
async fn device_authorization_happy_path() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=wildflower-host&scope=system%2F*.cruds";
    let req = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    // device_code/user_code are random, so thread them through; the rest of
    // the RFC 8628 §3.2 body (verification_uri, verification_uri_complete,
    // expires_in, interval) is pinned by the whole-value comparison.
    let device_code = body["device_code"].clone();
    let user_code = body["user_code"].as_str().expect("user_code").to_string();
    assert_eq!(
        body,
        serde_json::json!({
            "device_code": device_code,
            "user_code": user_code,
            // On the hosted owner UI, pointed back at this (loopback) server.
            "verification_uri": format!(
                "{OWNER_UI_BASE}gatekeeper/devices?server=http%3A%2F%2F127.0.0.1"
            ),
            "verification_uri_complete": format!(
                "{OWNER_UI_BASE}gatekeeper/devices?server=http%3A%2F%2F127.0.0.1&user_code={user_code}"
            ),
            "expires_in": 300,
            "interval": 5,
        })
    );
    // The user_code is also a well-formed, human-typeable pairing code — a
    // relationship the opaque whole-value comparison above can't express.
    assert!(gatekeeper_rust::crypto_util::oauth_user_code::is_valid_oauth_user_code(&user_code));
}

#[tokio::test]
async fn device_authorization_allows_scope_covered_by_client_wildcard() {
    // Coverage-aware allowlist (not exact string membership): the host client is
    // allowed `system/*.cruds`, which covers a request for the narrower
    // `system/Observation.rs`. The old exact-match gate rejected this with
    // `invalid_scope`; now it issues a device/user code pair like any allowed
    // scope.
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=wildflower-host&scope=system%2FObservation.rs";
    let req = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn device_authorization_unknown_client_returns_401() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=ghost&scope=system%2F*.cruds";
    let req = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_client");
}

#[tokio::test]
async fn token_exchange_unknown_code_returns_400_invalid_grant() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "grant_type=authorization_code&client_id=wildflower-host&\
                code=missing&code_verifier=verifierverifierverifierverifierverifierverifierverifier&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    // RFC 6749 §5.2: an unknown/unredeemable code is an `invalid_grant`, not a
    // malformed request.
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_grant");
}

/// RFC 7636 §4.1 caps the `code_verifier` at 43–128 chars. A too-short
/// verifier is rejected as `invalid_grant` before the code is even looked up.
#[tokio::test]
async fn token_exchange_short_code_verifier_returns_400_invalid_grant() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "grant_type=authorization_code&client_id=wildflower-host&\
                code=missing&code_verifier=tooshort&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(body["error_description"], "Invalid code_verifier parameter");
}

/// RFC 6749 §5.1/§5.2 require `Cache-Control: no-store` and `Pragma: no-cache`
/// on every `/oauth/token` response, including errors.
#[tokio::test]
async fn token_exchange_error_sets_cache_suppression_headers() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "grant_type=authorization_code&client_id=wildflower-host&\
                code=missing&code_verifier=verifierverifierverifierverifierverifierverifierverifier&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
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

/// RFC 6749 §3.2: the token endpoint requires a form-urlencoded body. The
/// `TokenRequest` extractor rejects any other `Content-Type` with a
/// cache-suppressed 400 `invalid_request` before any grant work happens.
#[tokio::test]
async fn token_exchange_rejects_non_form_content_type() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "grant_type=refresh_token&client_id=wildflower-host&refresh_token=whatever";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/json"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    // The rejection path must still be cache-suppressed (RFC 6749 §5.1).
    assert_eq!(
        res.headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_request");
}

/// The device-code grant's `grant_type` tag is the RFC 8628 URN, which
/// arrives percent-encoded (`urn%3Aietf%3A...`) — pins that the
/// form-urlencoded parse decodes it into the right enum variant (a
/// `Malformed payload` here would mean the parse, not the lookup,
/// failed; the TS client's wire format is pinned by
/// gatekeeper-core's oauth.test.ts).
#[tokio::test]
async fn token_exchange_unknown_device_code_returns_400_invalid_grant() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=missing";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(body["error_description"], "Unknown device_code");
}
