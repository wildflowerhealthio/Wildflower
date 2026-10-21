//! The OAuth endpoints' front-door rules: what `/oauth/authorize` parks, what
//! it renders locally and what it redirects back to the client (RFC 6749
//! §4.1.2.1: only to a redirect it trusts), how a parked request reaches and
//! leaves the Owner's prompt, the SMART App Launch `launch` and `aud`
//! parameters, and the request validation of `/oauth/device_authorization`
//! and `/oauth/token`.

use crate::common::*;

/// Trust on first use: a `client_id` this authorization server has never seen
/// isn't rejected at the door. Its request is parked like any other and the
/// browser is sent to wait for the Owner, and **nothing** is written to the
/// `clients` table, so a request nobody approves leaves no trace of the app.
#[tokio::test]
async fn authorize_unknown_client_parks_a_pending_request() {
    let (g, _owner_token, db) = spin_up();
    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query("ghost", "read"),
    )
    .await;
    let request_id = parked_request_id(&res);

    let res = get_authorization_status(&g.router, &db.paired_browser_token, &request_id).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "pending");
    assert!(
        store_handle(&db)
            .read(|tx| tx.client_by_id("ghost"))
            .expect("client query")
            .is_none(),
        "/authorize must not register an unknown client",
    );
}

/// The redirect of an unknown client is untrusted, so a later validation failure
/// may NOT be 302'd to it (RFC 6749 §4.1.2.1's open-redirect rule): a malformed
/// PKCE challenge and a non-`code` `response_type` both render the local HTML
/// page instead.
#[tokio::test]
async fn authorize_unknown_client_renders_later_failures_locally() {
    let (g, _owner_token, db) = spin_up();
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
        let res = get_authorize(&g.router, &db.paired_browser_token, &query).await;
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
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://elsewhere.example/cb", &["read"]);
    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query("test-app", "read"),
    )
    .await;
    parked_request_id(&res);

    let query = "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let res = get_authorize(&g.router, &db.paired_browser_token, query).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(
        body.contains("Invalid PKCE code challenge"),
        "body = {body}"
    );
}

/// A disabled client, even one registered by trust on first use, is rejected at
/// `/oauth/authorize` with the local "Disabled client" page — the one
/// client-level rejection trust-on-first-use does not relax.
#[tokio::test]
async fn authorize_disabled_client_is_still_rejected() {
    let (g, _owner_token, db) = spin_up();
    // Inserted disabled: `upsert_client` deliberately preserves `disabled_at`,
    // so the flag has to be set on the row's first write.
    store_handle(&db)
        .write(|tx| {
            tx.upsert_client(&Client {
                client_id: "test-app".to_string(),
                name: "Disabled Test Client".to_string(),
                kind: ClientKind::Public,
                redirect_uris: vec![Url::parse("https://app.example/cb").unwrap()],
                allowed_scopes: vec!["read".to_string()],
                allowed_grant_types: AllowedGrantType::ALL.to_vec(),
                secret_hash: None,
                registered_at: Utc::now(),
                disabled_at: Some(Utc::now()),
                registration_source: RegistrationSource::TrustedOnFirstUse,
                refresh_policy: CEILING_ONLY_REFRESH_POLICY,
            })
        })
        .expect("register a disabled client");

    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query("test-app", "read"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(body.contains("Disabled client"), "body = {body}");
}

/// RFC 6749 §4.1.2.1: the client and its redirect are validated before any
/// redirectable error (scope, PKCE method), since those failures are 302'd back
/// to the validated redirect. The host app's client has a fixed registration
/// with no allowed redirects, so even with an unsupported
/// `code_challenge_method=plain` the request fails at the redirect check and
/// renders the local "Redirect URI not allowed" page rather than redirecting.
#[tokio::test]
async fn authorize_validates_redirect_uri_before_pkce_method() {
    let (g, _owner_token, db) = spin_up();
    let query = format!(
        "response_type=code&code_challenge_method=plain&client_id={WILDFLOWER_HOST_APP_CLIENT_ID}&\
         scope=owner&code_challenge=abc&redirect_uri=http%3A%2F%2Fexample.com%2Fcb&state=xyz"
    );
    let req = build_request(
        Request::get(format!("/oauth/authorize?{query}"))
            .header("cookie", browser_session_cookie(&db.paired_browser_token)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(body.contains("Redirect URI not allowed"), "body = {body}");
}

/// `unsupported_response_type` is a redirectable error (RFC 6749 §4.1.2.1):
/// once the client and its redirect validate, the failure goes back to the
/// client as `error` and `state` query parameters, not a local page.
#[tokio::test]
async fn authorize_unsupported_response_type_redirects_back() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=token&code_challenge_method=S256&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = build_request(
        Request::get(format!("/oauth/authorize?{query}"))
            .header("cookie", browser_session_cookie(&db.paired_browser_token)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=unsupported_response_type&error_description=\
         The+app+asked+for+a+kind+of+sign-in+this+server+doesn%27t+support.&state=xyz"
    );
}

/// Once the client and its redirect validate, an unsupported PKCE method
/// (`plain`) goes back to the client as `invalid_request` with its `state`.
#[tokio::test]
async fn authorize_unsupported_pkce_method_redirects_invalid_request() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=code&code_challenge_method=plain&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = build_request(
        Request::get(format!("/oauth/authorize?{query}"))
            .header("cookie", browser_session_cookie(&db.paired_browser_token)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=invalid_request&error_description=\
         The+app%27s+sign-in+request+uses+a+security+method+this+server+doesn%27t+support.\
         &state=xyz"
    );
}

/// A scope outside a client's registration (one not fixed) doesn't fail the
/// request: it is carried to the Owner's prompt as a `changed` registration
/// naming exactly the scopes that stepped outside. The registered redirect stays
/// trusted, so a *different* failure on the same request still 302s back (see
/// `authorize_unsupported_pkce_method_redirects_invalid_request`).
#[tokio::test]
async fn authorize_disallowed_scope_parks_a_pending_request() {
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query("test-app", "read%20write"),
    )
    .await;
    let request_id = parked_request_id(&res);

    let consent = get_oauth_consent(&g, &owner_token, &request_id).await;
    assert_eq!(
        consent["registration"],
        serde_json::json!({
            "status": "changed",
            "redirectUriIsNew": false,
            "newScopes": ["write"],
        }),
    );
}

/// A parked `/authorize` request must reach the host, not only the wait page.
/// The wait page tells its viewer to "approve this request on your device"; if
/// the request is never published as the Owner prompt, the host
/// never notifies it and the flow hangs until the 5-minute TTL.
#[tokio::test]
async fn authorize_publishes_the_parked_request_as_the_owner_prompt() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    assert_eq!(owner_prompt(&db), None, "no request has been parked yet");

    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query("test-app", "read"),
    )
    .await;
    let request_id = parked_request_id(&res);

    assert_eq!(
        owner_prompt(&db),
        Some(OwnerPrompt::AuthorizationCode {
            id: request_id.clone(),
            client_name: "Integration Test Client".to_owned(),
            decidable_in_requesting_browser: false,
        }),
        "the newest must be the request the browser was just parked on, named for its client",
    );
}

/// Deciding a parked request clears it from the host: the Owner answered it,
/// so it must not linger as the Owner prompt. Covers approve
/// and deny separately — they take different paths to the same republish.
#[tokio::test]
async fn deciding_an_oauth_consent_clears_the_owner_prompt() {
    for decision in ["approve", "deny"] {
        let (g, owner_token, db) = spin_up();
        seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
        let res = get_authorize(
            &g.router,
            &db.paired_browser_token,
            &authorize_query("test-app", "read"),
        )
        .await;
        let request_id = parked_request_id(&res);
        assert!(
            owner_prompt(&db).is_some(),
            "{decision}: the request should be pending before it is decided",
        );

        let res = g
            .router
            .clone()
            .oneshot(build_request(
                Request::post(format!(
                    "/authorization/oauth-consents/{request_id}/{decision}"
                ))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json"),
                Body::from(r#"{"approvedScopes":["read"],"acknowledgedRegistrationChange":true}"#),
            ))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK, "{decision} should succeed");

        assert_eq!(
            owner_prompt(&db),
            None,
            "{decision}: the request must clear once it is decided",
        );
    }
}

/// The host's `PendingConsentWatcher` sees a request settle even when it
/// isn't the newest: denying an older request while a newer one waits leaves
/// the Owner prompt unchanged, so nothing reaches the host through
/// that.
#[tokio::test]
async fn the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one() {
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let older_id = parked_request_id(
        &get_authorize(
            &g.router,
            &db.paired_browser_token,
            &authorize_query("test-app", "read"),
        )
        .await,
    );
    let newer_id = parked_request_id(
        &get_authorize(
            &g.router,
            &db.paired_browser_token,
            &authorize_query("test-app", "read"),
        )
        .await,
    );
    let watcher = g.pending_consent_watcher.clone();
    let older_key = ConsentKey::AuthorizationCode {
        id: older_id.clone(),
    };
    let older_settled = tokio::spawn(async move { watcher.until_settled(older_key).await });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        !older_settled.is_finished(),
        "the older request still waits"
    );

    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::post(format!("/authorization/oauth-consents/{older_id}/deny"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json"),
            Body::from(r#"{"approvedScopes":["read"],"acknowledgedRegistrationChange":true}"#),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);

    tokio::time::timeout(std::time::Duration::from_secs(5), older_settled)
        .await
        .expect("the watcher sees the older request settle")
        .expect("the watcher's task")
        .expect("the watcher's reads");
    assert_eq!(
        owner_prompt(&db),
        Some(OwnerPrompt::AuthorizationCode {
            id: newer_id,
            client_name: "Integration Test Client".to_owned(),
            decidable_in_requesting_browser: false,
        }),
        "the newer request is still the newest",
    );
}

/// The grant fast path approves inside `/authorize` itself, so its request is
/// never awaiting a human — it must not be published on its way through
/// `pending`. A spurious notification here would ask the Owner to re-approve something
/// they already consented to, on a request that is already `approved`.
#[tokio::test]
async fn a_fast_pathed_authorize_never_becomes_the_owner_prompt() {
    let (g, owner_token, db) = spin_up();
    seed_test_client(&db);
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    // First pass: park, approve, and so establish the standing grant.
    authorize_and_approve(
        &g,
        &owner_token,
        &db.paired_browser_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"],"acknowledgedRegistrationChange":true}"#,
    )
    .await;
    assert_eq!(
        owner_prompt(&db),
        None,
        "the approved first request left nothing pending"
    );

    // Second pass: the grant now pre-approves every requested scope, so
    // /authorize issues a code and 302s straight back to the client.
    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query("test-app", "read"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = location_of(&res);
    assert!(
        location.starts_with("https://app.example/cb?code="),
        "expected the fast path's client redirect, got {location}"
    );
    assert_eq!(
        owner_prompt(&db),
        None,
        "a fully pre-approved request must never be published as pending",
    );
}

/// The host app's client is NOT trusted on first use: its registration is
/// fixed, so an unregistered scope for it is the `invalid_scope` redirect back
/// to its registered redirect_uri, not a request parked for the Owner.
#[tokio::test]
async fn authorize_host_app_disallowed_scope_still_redirects_invalid_scope() {
    let (g, _owner_token, db) = spin_up();
    // Give the host client a redirect so the request reaches the scope check.
    let store = store_handle(&db);
    let mut host = store
        .read(|tx| tx.client_by_id(WILDFLOWER_HOST_APP_CLIENT_ID))
        .unwrap()
        .expect("the seeded host app's client");
    host.redirect_uris = vec![Url::parse("https://app.example/cb").unwrap()];
    store
        .write(|tx| tx.upsert_client(&host))
        .expect("allowlist a redirect");

    let res = get_authorize(
        &g.router,
        &db.paired_browser_token,
        &authorize_query(WILDFLOWER_HOST_APP_CLIENT_ID, "definitely_not_granted"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(
        location_of(&res),
        "https://app.example/cb?error=invalid_scope&error_description=\
         The+app+asked+for+access+it+isn%27t+registered+for.&state=xyz"
    );
}

/// The registration check is by coverage, not exact string membership: a
/// client allowed `patient/Observation.rs` also admits a request for the
/// narrower `patient/Observation.r` it covers, which parks like any allowed
/// scope rather than redirecting back with an `error`.
#[tokio::test]
async fn authorize_allows_scope_covered_by_a_broader_allowed_scope() {
    let (g, _owner_token, db) = spin_up();
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
        .oneshot(build_request(
            Request::get(format!("/oauth/authorize?{query}"))
                .header("cookie", browser_session_cookie(&db.paired_browser_token)),
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

/// Coverage never bridges the SMART v1 word and v2 letter grammars, as in
/// scopes-core: a client registered with the v1 `patient/Observation.read`
/// doesn't cover a request for the letter-equivalent `patient/Observation.rs`,
/// because v1 apps request v1 scopes. The request is parked for the Owner as a
/// registration change naming the uncovered spelling.
#[tokio::test]
async fn authorize_treats_a_cross_grammar_scope_request_as_new() {
    let (g, owner_token, db) = spin_up();
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
    let res = get_authorize(&g.router, &db.paired_browser_token, &query).await;
    // Not covered → not `registered`; the request is parked for the Owner rather
    // than rejected, and the prompt names the uncovered spelling.
    let request_id = parked_request_id(&res);
    let consent = get_oauth_consent(&g, &owner_token, &request_id).await;
    assert_eq!(
        consent["registration"]["newScopes"],
        serde_json::json!(["patient/Observation.rs"]),
    );
}

/// The `/oauth/authorize` query for `test-app` with SMART App Launch params
/// appended (each already URL-encoded).
fn smart_launch_query(smart_params: &str) -> String {
    format!("{}&{smart_params}", authorize_query("test-app", "read"))
}

/// Where `/oauth/authorize` sends a replayed launch: back to the client,
/// told the launch was already used.
const ALREADY_USED_LOCATION: &str = "https://app.example/cb?error=invalid_request\
     &error_description=This+launch+was+already+used.+Open+the+app+again.&state=xyz";

/// A SMART App Launch round trip: a `launch` minted for the client and the FHIR
/// base (the server's origin) as `aud` park a pending request the Owner can approve, and the request
/// carries the consumed launch. The same `launch` is refused the second time.
#[tokio::test]
async fn authorize_consumes_a_smart_launch_once() {
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let launch = g
        .launch_context_minter
        .mint("test-app")
        .expect("mint a launch");
    let query = smart_launch_query(&format!(
        "launch={launch}&aud=https%3A%2F%2Fruth.relay.example"
    ));

    let request_id =
        parked_request_id(&get_authorize(&g.router, &db.paired_browser_token, &query).await);
    let parked = store_handle(&db)
        .read(|tx| tx.code_request_by_id(&request_id))
        .expect("query")
        .expect("parked");
    assert_eq!(parked.launch.as_deref(), Some(launch.as_str()));
    assert_eq!(parked.launch_bound_patient, None);
    let res = approve_oauth_consent(
        &g,
        &owner_token,
        &request_id,
        r#"{"approvedScopes":["read"],"patient":null,"acknowledgedRegistrationChange":true}"#
            .to_owned(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let replay = get_authorize(&g.router, &db.paired_browser_token, &query).await;
    assert_eq!(replay.status(), StatusCode::FOUND);
    assert_eq!(
        location_of(&replay),
        ALREADY_USED_LOCATION,
        "a consumed launch is refused"
    );
}

/// A launch minted for the server launcher, which names no client, is consumed
/// by the first client to present it at `/oauth/authorize`; a replay redirects
/// to the client's callback with `invalid_request`, "This launch was already
/// used."
#[tokio::test]
async fn authorize_consumes_a_server_launcher_launch_once() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let launch = g
        .launch_context_minter
        .mint_for_server_launcher()
        .expect("mint a launch");
    let query = smart_launch_query(&format!("launch={launch}"));

    let request_id =
        parked_request_id(&get_authorize(&g.router, &db.paired_browser_token, &query).await);
    let parked = store_handle(&db)
        .read(|tx| tx.code_request_by_id(&request_id))
        .expect("query")
        .expect("parked");
    assert_eq!(parked.launch.as_deref(), Some(launch.as_str()));

    let replay = get_authorize(&g.router, &db.paired_browser_token, &query).await;
    assert_eq!(
        location_of(&replay),
        ALREADY_USED_LOCATION,
        "a consumed launch is refused"
    );
}

/// A forged `launch`, one minted for another client, and an `aud` naming
/// another server are each `invalid_request` back to the trusted redirect; a
/// request with neither param is plain OAuth, as is one with just the server's
/// origin as `aud`.
#[tokio::test]
async fn authorize_refuses_a_bad_smart_launch_or_aud() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let other_clients_launch = g
        .launch_context_minter
        .mint("other-app")
        .expect("mint a launch");
    // The forged launch and the other client's read the same, so the redirect
    // tells the two apart no more than it says anything about the other
    // client's launch.
    let not_recognized = "https://app.example/cb?error=invalid_request&error_description=\
                          This+launch+isn%27t+recognized.+Open+the+app+again.&state=xyz";
    let wrong_server = "https://app.example/cb?error=invalid_request&error_description=\
                        The+app+asked+for+a+different+server+than+this+one.&state=xyz";
    for (smart_params, expected_location) in [
        ("launch=forged-launch".to_owned(), not_recognized),
        (format!("launch={other_clients_launch}"), not_recognized),
        (
            "aud=https%3A%2F%2Fapp.example%2Ffhir-r4".to_owned(),
            wrong_server,
        ),
    ] {
        let res = get_authorize(
            &g.router,
            &db.paired_browser_token,
            &smart_launch_query(&smart_params),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FOUND);
        assert_eq!(
            location_of(&res),
            expected_location,
            "{smart_params} is refused"
        );
    }

    parked_request_id(
        &get_authorize(
            &g.router,
            &db.paired_browser_token,
            &authorize_query("test-app", "read"),
        )
        .await,
    );
    parked_request_id(
        &get_authorize(
            &g.router,
            &db.paired_browser_token,
            &smart_launch_query("aud=https%3A%2F%2Fruth.relay.example"),
        )
        .await,
    );
}

/// An unknown client's redirect is untrusted, so a bad `launch` or `aud`
/// renders the local error page rather than redirecting.
#[tokio::test]
async fn authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect() {
    let (g, _owner_token, db) = spin_up();
    for (smart_params, title) in [
        ("launch=forged-launch", "Launch not recognized"),
        ("aud=https%3A%2F%2Fapp.example%2Ffhir-r4", "Wrong server"),
    ] {
        let query = format!("{}&{smart_params}", authorize_query("ghost", "read"));
        let res = get_authorize(&g.router, &db.paired_browser_token, &query).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(
            body_string(res.into_body()).await.contains(title),
            "{smart_params} renders {title}"
        );
    }
}

/// A device-authorization start for a registered client answers the RFC 8628
/// §3.2 body: random device and user codes, this server's own device page as
/// `verification_uri` (and with the user code in `verification_uri_complete`),
/// a five-minute expiry and a five-second poll interval. The user code is
/// human-typeable.
#[tokio::test]
async fn device_authorization_happy_path() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let body = "client_id=integration-test-app&scope=system%2F*.cruds";
    let req = build_request(
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
            // This server's own device page, on its origin.
            "verification_uri": "https://ruth.relay.example/oauth/device",
            "verification_uri_complete": format!(
                "https://ruth.relay.example/oauth/device?user_code={user_code}"
            ),
            "expires_in": 300,
            "interval": 5,
        })
    );
    // The user_code is also a well-formed, human-typeable pairing code — a
    // relationship the opaque whole-value comparison above can't express.
    assert!(
        wildflowerhealthio_authorization_server::crypto_util::oauth_user_code::is_valid_oauth_user_code(
            &user_code
        )
    );
}

/// The device flow's registration check is by coverage too: the test client
/// is allowed `system/*.cruds`, which covers a request for the narrower
/// `system/Observation.rs`, so it is issued a device and user code like any
/// allowed scope.
#[tokio::test]
async fn device_authorization_allows_scope_covered_by_client_wildcard() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let body = "client_id=integration-test-app&scope=system%2FObservation.rs";
    let req = build_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

/// A device-authorization start from a client that isn't registered is
/// `401 invalid_client`: the device flow has no trust on first use.
#[tokio::test]
async fn device_authorization_unknown_client_returns_401() {
    let (g, _owner_token, _db) = spin_up();
    let body = "client_id=ghost&scope=system%2F*.cruds";
    let req = build_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_client");
}

/// Redeeming a code the server never issued is `400 invalid_grant`, not a
/// malformed request (RFC 6749 §5.2).
#[tokio::test]
async fn token_exchange_unknown_code_returns_400_invalid_grant() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let body = "grant_type=authorization_code&client_id=integration-test-app&\
                code=missing&code_verifier=verifierverifierverifierverifierverifierverifierverifier&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = build_request(
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
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let body = "grant_type=authorization_code&client_id=integration-test-app&\
                code=missing&code_verifier=tooshort&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = build_request(
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
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let body = "grant_type=authorization_code&client_id=integration-test-app&\
                code=missing&code_verifier=verifierverifierverifierverifierverifierverifierverifier&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = build_request(
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
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let body = "grant_type=refresh_token&client_id=integration-test-app&refresh_token=whatever";
    let req = build_request(
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
/// authorization-core's oauth.test.ts).
#[tokio::test]
async fn token_exchange_unknown_device_code_returns_400_invalid_grant() {
    let (g, _owner_token, db) = spin_up();
    seed_test_client(&db);
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=integration-test-app&device_code=missing";
    let req = build_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(body["error_description"], "Unknown device_code");
}
