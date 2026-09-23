use crate::common::*;

// --- Owner client management (`/access/clients`, #162) ------------------------
//
// The other half of trust on first use: the Owner can see every client they
// trust (migration-seeded or TOFU-created) and take that trust back. A disabled
// client is refused at both OAuth front doors; re-enabling restores it with its
// registration intact. The first-party host client can't be disabled.

/// `GET /access/clients` as `token`.
async fn list_clients(g: &Gatekeeper, token: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/clients")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// The `GET /access/clients` rows, asserting the list itself succeeded.
async fn listed_clients(g: &Gatekeeper, token: &str) -> Vec<Value> {
    let res = list_clients(g, token).await;
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body())
        .await
        .as_array()
        .expect("a JSON array")
        .clone()
}

fn find_client<'a>(clients: &'a [Value], client_id: &str) -> Option<&'a Value> {
    clients.iter().find(|c| c["clientId"] == client_id)
}

/// `POST /access/clients/{client_id}/{action}` as `token`.
async fn switch_client(
    g: &Gatekeeper,
    token: &str,
    client_id: &str,
    action: &str,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::post(format!("/access/clients/{client_id}/{action}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// The refresh-token exchange the confidential test client can always make
/// (credentials in the body — `client_secret_post`).
async fn refresh_as_confidential_client(g: &Gatekeeper) -> axum::response::Response {
    post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token&client_id=conf-app&\
         client_secret=shhh-integration-secret",
    )
    .await
}

#[tokio::test]
async fn list_shows_seeded_and_trusted_on_first_use_clients_without_secrets() {
    let (g, host_owner_token, db) = spin_up();
    seed_confidential_client(&db, "conf-app", "a-secret", &["read"]);

    // Trust a brand-new app on first use.
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

    let clients = listed_clients(&g, &host_owner_token).await;

    // Seeded by boot (the host) and by migration (a SMART app).
    let host = find_client(&clients, "wildflower-host").expect("the host client is listed");
    assert_eq!(host["firstParty"], true);
    assert!(find_client(&clients, "ohif-viewer").is_some());

    // Created by the TOFU approval, exactly as it was registered.
    let tofu = find_client(&clients, "brand-new-app").expect("the TOFU client is listed");
    assert_eq!(
        tofu,
        &serde_json::json!({
            "clientId": "brand-new-app",
            "name": "brand-new-app",
            "kind": "public",
            "redirectUris": ["https://app.example/cb"],
            "allowedScopes": ["read"],
            "allowedGrantTypes": [
                "authorization_code",
                "refresh_token",
                "urn:ietf:params:oauth:grant-type:device_code",
            ],
            "registeredAt": tofu["registeredAt"],
            "disabledAt": null,
            "firstParty": false,
        }),
    );
    assert!(tofu["registeredAt"].is_string());

    // Ordered by id, and the secret hash never leaves the server.
    let ids: Vec<&str> = clients
        .iter()
        .map(|c| c["clientId"].as_str().expect("clientId"))
        .collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted);
    let confidential = find_client(&clients, "conf-app").expect("the confidential client");
    assert_eq!(confidential["kind"], "confidential");
    for client in &clients {
        let fields = client.as_object().expect("a JSON object");
        assert!(
            !fields.keys().any(|k| k.to_lowercase().contains("secret")),
            "no secret field on {}",
            client["clientId"],
        );
    }
}

#[tokio::test]
async fn a_disabled_client_is_refused_at_authorize_until_re_enabled() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = authorize_query("test-app", "read");

    // Enabled: the request parks for the Owner.
    parked_request_id(&get_authorize(&g.router, &query).await);

    let res = switch_client(&g, &host_owner_token, "test-app", "disable").await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let disabled = listed_clients(&g, &host_owner_token).await;
    assert!(find_client(&disabled, "test-app").expect("listed")["disabledAt"].is_string());

    // Disabled: a local error page, never a redirect to the client or a prompt.
    let res = get_authorize(&g.router, &query).await;
    assert_ne!(res.status(), StatusCode::FOUND);
    assert!(body_string(res.into_body())
        .await
        .contains("Disabled client"));

    let res = switch_client(&g, &host_owner_token, "test-app", "enable").await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // Re-enabled with its registration intact: the same request parks again.
    parked_request_id(&get_authorize(&g.router, &query).await);
    let enabled = listed_clients(&g, &host_owner_token).await;
    let row = find_client(&enabled, "test-app").expect("listed");
    assert_eq!(row["disabledAt"], Value::Null);
    assert_eq!(
        row["redirectUris"],
        serde_json::json!(["https://app.example/cb"])
    );
    assert_eq!(row["allowedScopes"], serde_json::json!(["read"]));
}

#[tokio::test]
async fn a_disabled_client_is_refused_at_token_until_re_enabled() {
    let (g, db) = spin_up_with_confidential_client();
    let owner = mint_scoped_token(&db, &["wildflower/Client.u"]);

    let res = switch_client(&g, &owner, CONFIDENTIAL_CLIENT_ID, "disable").await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let res = refresh_as_confidential_client(&g).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_client");
    assert_eq!(body["error_description"], "Client is disabled");

    let res = switch_client(&g, &owner, CONFIDENTIAL_CLIENT_ID, "enable").await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // The refused attempt consumed nothing: the same refresh token now redeems.
    let res = refresh_as_confidential_client(&g).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["token_type"], "Bearer");
}

#[tokio::test]
async fn disable_and_enable_are_idempotent() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);

    let res = switch_client(&g, &host_owner_token, "test-app", "disable").await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let first = store_handle(&db)
        .client_by_id("test-app")
        .unwrap()
        .expect("row")
        .disabled_at
        .expect("disabled");
    let res = switch_client(&g, &host_owner_token, "test-app", "disable").await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    let again = store_handle(&db)
        .client_by_id("test-app")
        .unwrap()
        .expect("row")
        .disabled_at;
    assert_eq!(again, Some(first), "a repeat keeps the first timestamp");

    for _ in 0..2 {
        let res = switch_client(&g, &host_owner_token, "test-app", "enable").await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }
    assert!(store_handle(&db)
        .client_by_id("test-app")
        .unwrap()
        .expect("row")
        .disabled_at
        .is_none());
}

#[tokio::test]
async fn an_unknown_client_is_a_404_for_both_switches() {
    let (g, host_owner_token, _db) = spin_up();
    for action in ["disable", "enable"] {
        let res = switch_client(&g, &host_owner_token, "ghost", action).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{action}");
        assert_eq!(
            body_json(res.into_body()).await,
            serde_json::json!({ "error": "ClientNotFound", "clientId": "ghost" }),
        );
    }
}

#[tokio::test]
async fn the_first_party_host_client_cannot_be_disabled() {
    let (g, host_owner_token, db) = spin_up();

    let res = switch_client(&g, &host_owner_token, "wildflower-host", "disable").await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "error": "FirstPartyClientLocked", "clientId": "wildflower-host" }),
    );
    assert!(store_handle(&db)
        .client_by_id("wildflower-host")
        .unwrap()
        .expect("the host client row")
        .disabled_at
        .is_none());
    // The Owner's session still works.
    assert_eq!(
        list_clients(&g, &host_owner_token).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn unauthenticated_callers_are_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let requests = [
        Request::get("/access/clients"),
        Request::post("/access/clients/test-app/disable"),
        Request::post("/access/clients/test-app/enable"),
    ];
    for builder in requests {
        let res = g
            .router
            .clone()
            .oneshot(loopback_request(
                builder.header("host", "127.0.0.1"),
                Body::empty(),
            ))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
    assert!(store_handle(&db)
        .client_by_id("test-app")
        .unwrap()
        .expect("row")
        .disabled_at
        .is_none());
}

#[tokio::test]
async fn under_scoped_callers_are_rejected_before_the_handler() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);

    // Listing needs `Client.r`; a grants reader doesn't have it.
    let grants_reader = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let res = list_clients(&g, &grants_reader).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["wildflower/Client.r"]),
    );

    // Switching needs `Client.u`; reading clients isn't enough — and the gate
    // runs first, so even an unknown id is a 403, not a 404.
    let clients_reader = mint_scoped_token(&db, &["wildflower/Client.r"]);
    assert_eq!(
        list_clients(&g, &clients_reader).await.status(),
        StatusCode::OK
    );
    for (client_id, action) in [
        ("test-app", "disable"),
        ("test-app", "enable"),
        ("ghost", "disable"),
    ] {
        let res = switch_client(&g, &clients_reader, client_id, action).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{client_id} {action}");
        assert_eq!(
            body_json(res.into_body()).await["missingScopes"],
            serde_json::json!(["wildflower/Client.u"]),
        );
    }
    assert!(store_handle(&db)
        .client_by_id("test-app")
        .unwrap()
        .expect("row")
        .disabled_at
        .is_none());
}
