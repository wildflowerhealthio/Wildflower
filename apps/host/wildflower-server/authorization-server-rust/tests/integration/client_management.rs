use chrono::DateTime;

use crate::common::*;

// --- Owner client management (`/authorization/clients`, #162) ------------------------
//
// The other half of trust on first use: the Owner can see every client they
// trust (migration-seeded or TOFU-created) and take that trust back by PATCHing
// its `disabledAt`. A disabled client is refused at both OAuth front doors at
// once; re-enabling (`null`) restores it with its registration intact. An essential client can't be disabled.

/// `GET /authorization/clients` as `token`.
async fn list_clients(g: &AuthorizationServer, token: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::get("/authorization/clients")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// The `GET /authorization/clients` rows, asserting the list itself succeeded.
async fn listed_clients(g: &AuthorizationServer, token: &str) -> Vec<Value> {
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

/// The stored `disabled_at` of `client_id`.
fn stored_disabled_at(db: &TestDb, client_id: &str) -> Option<DateTime<Utc>> {
    store_handle(db)
        .client_by_id(client_id)
        .unwrap()
        .expect("row")
        .disabled_at
}

/// A response body's `disabledAt`, parsed.
fn disabled_at_of(client: &Value) -> Option<DateTime<Utc>> {
    client["disabledAt"]
        .as_str()
        .map(|at| at.parse().expect("an RFC 3339 disabledAt"))
}

/// The refresh-token exchange the confidential test client can always make
/// (credentials in the body — `client_secret_post`).
async fn refresh_as_confidential_client(g: &AuthorizationServer) -> axum::response::Response {
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
    let (g, owner_token, db) = spin_up();
    seed_confidential_client(&db, "conf-app", "a-secret", &["read"]);

    // Trust a brand-new app on first use.
    let res = get_authorize(&g.router, &authorize_query("brand-new-app", "read")).await;
    let request_id = parked_request_id(&res);
    let res = approve_oauth_consent(
        &g,
        &owner_token,
        &request_id,
        r#"{"approvedScopes":["read"],"acknowledgedRegistration":true}"#.to_string(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);

    let clients = listed_clients(&g, &owner_token).await;

    // Seeded by boot (the host) and by migration (a SMART app).
    let host =
        find_client(&clients, WILDFLOWER_HOST_APP_CLIENT_ID).expect("the host client is listed");
    assert_eq!(host["essential"], true);
    let owner_browser =
        find_client(&clients, OWNER_BROWSER_CLIENT_ID).expect("the Owner-browser client is listed");
    assert_eq!(owner_browser["essential"], true);
    assert!(find_client(&clients, "941de68e6b59eb9dcc32df8ede89e636").is_some());

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
            "essential": false,
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
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = authorize_query("test-app", "read");

    // Enabled: the request parks for the Owner.
    parked_request_id(&get_authorize(&g.router, &query).await);

    // The PATCH answers with the client as stored — the same row the list shows.
    let res = disable_client(&g, &owner_token, "test-app", Utc::now()).await;
    assert_eq!(res.status(), StatusCode::OK);
    let patched = body_json(res.into_body()).await;
    assert!(patched["disabledAt"].is_string());
    let listed = listed_clients(&g, &owner_token).await;
    assert_eq!(find_client(&listed, "test-app"), Some(&patched));

    // Disabled: a local error page, never a redirect to the client or a prompt.
    let res = get_authorize(&g.router, &query).await;
    assert_ne!(res.status(), StatusCode::FOUND);
    assert!(body_string(res.into_body())
        .await
        .contains("Disabled client"));

    let res = enable_client(&g, &owner_token, "test-app").await;
    assert_eq!(res.status(), StatusCode::OK);

    // Re-enabled with its registration intact: the same request parks again.
    parked_request_id(&get_authorize(&g.router, &query).await);
    let row = body_json(res.into_body()).await;
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

    let res = disable_client(&g, &owner, CONFIDENTIAL_CLIENT_ID, Utc::now()).await;
    assert_eq!(res.status(), StatusCode::OK);

    let res = refresh_as_confidential_client(&g).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_client");
    assert_eq!(body["error_description"], "Client is disabled");

    let res = enable_client(&g, &owner, CONFIDENTIAL_CLIENT_ID).await;
    assert_eq!(res.status(), StatusCode::OK);

    // The refused attempt consumed nothing: the same refresh token now redeems.
    let res = refresh_as_confidential_client(&g).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["token_type"], "Bearer");
}

/// Whatever time is sent — long past or an hour ahead — the client is disabled
/// now, stamped with the server's clock: a disable can be neither backdated nor
/// scheduled.
#[tokio::test]
async fn any_sent_disabled_at_disables_now_with_the_servers_time() {
    let (g, db) = spin_up_with_confidential_client();
    let owner = mint_scoped_token(&db, &["wildflower/Client.u"]);

    for sent in [
        Utc::now() - Duration::days(365),
        Utc::now() + Duration::hours(1),
    ] {
        let before = Utc::now();
        let res = disable_client(&g, &owner, CONFIDENTIAL_CLIENT_ID, sent).await;
        let after = Utc::now();
        assert_eq!(res.status(), StatusCode::OK);
        let answered = disabled_at_of(&body_json(res.into_body()).await).expect("disabled");
        assert!(
            (before..=after).contains(&answered),
            "stamped with the server's now, not the time sent ({sent})"
        );
        assert_eq!(
            stored_disabled_at(&db, CONFIDENTIAL_CLIENT_ID),
            Some(answered)
        );

        let res = refresh_as_confidential_client(&g).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "refused at once");

        let res = enable_client(&g, &owner, CONFIDENTIAL_CLIENT_ID).await;
        assert_eq!(res.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn disable_and_enable_are_idempotent() {
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);

    let res = disable_client(&g, &owner_token, "test-app", Utc::now()).await;
    assert_eq!(res.status(), StatusCode::OK);
    let first = stored_disabled_at(&db, "test-app").expect("disabled");
    let later = Utc::now() + Duration::hours(1);
    let res = disable_client(&g, &owner_token, "test-app", later).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        disabled_at_of(&body_json(res.into_body()).await),
        Some(first),
        "a repeat answers with the first timestamp",
    );
    assert_eq!(
        stored_disabled_at(&db, "test-app"),
        Some(first),
        "a repeat keeps the first timestamp",
    );

    for _ in 0..2 {
        let res = enable_client(&g, &owner_token, "test-app").await;
        assert_eq!(res.status(), StatusCode::OK);
    }
    assert_eq!(stored_disabled_at(&db, "test-app"), None);
}

#[tokio::test]
async fn an_unknown_client_is_a_404_either_way() {
    let (g, owner_token, _db) = spin_up();
    for disabled_at in [Value::from(Utc::now().to_rfc3339()), Value::Null] {
        let body = serde_json::json!({ "disabledAt": disabled_at });
        let res = patch_client(&g, &owner_token, "ghost", &body).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{body}");
        assert_eq!(
            body_json(res.into_body()).await,
            serde_json::json!({ "error": "ClientNotFound", "clientId": "ghost" }),
        );
    }
}

#[tokio::test]
async fn a_body_without_disabled_at_is_rejected_and_writes_nothing() {
    let (g, owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let res = disable_client(&g, &owner_token, "test-app", Utc::now()).await;
    assert_eq!(res.status(), StatusCode::OK);
    let disabled_at = stored_disabled_at(&db, "test-app");

    // Omitting the field must not read as `null` and re-enable the client, and
    // an unknown field is refused rather than ignored.
    for body in [
        serde_json::json!({}),
        serde_json::json!({ "disabledAt": null, "name": "renamed" }),
        serde_json::json!({ "disabledAt": "not a time" }),
    ] {
        let res = patch_client(&g, &owner_token, "test-app", &body).await;
        assert!(res.status().is_client_error(), "{body}");
        assert_eq!(stored_disabled_at(&db, "test-app"), disabled_at, "{body}");
    }
}

#[tokio::test]
async fn an_essential_client_cannot_be_disabled() {
    let (g, owner_token, db) = spin_up();

    for essential_client_id in [WILDFLOWER_HOST_APP_CLIENT_ID, OWNER_BROWSER_CLIENT_ID] {
        let res = disable_client(&g, &owner_token, essential_client_id, Utc::now()).await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(res.into_body()).await,
            serde_json::json!({ "error": "EssentialClient", "clientId": essential_client_id }),
        );
        assert_eq!(stored_disabled_at(&db, essential_client_id), None);
        // The Owner's session still works, and enabling the client stays allowed.
        assert_eq!(
            list_clients(&g, &owner_token).await.status(),
            StatusCode::OK
        );
        let res = enable_client(&g, &owner_token, essential_client_id).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res.into_body()).await["essential"], true);
    }
}

#[tokio::test]
async fn unauthenticated_callers_are_rejected() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let disable = serde_json::json!({ "disabledAt": Utc::now().to_rfc3339() }).to_string();
    let requests = [
        (Request::get("/authorization/clients"), Body::empty()),
        (
            Request::patch("/authorization/clients/test-app")
                .header("content-type", "application/json"),
            Body::from(disable),
        ),
    ];
    for (builder, body) in requests {
        let res = g
            .router
            .clone()
            .oneshot(loopback_request(builder.header("host", "127.0.0.1"), body))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(stored_disabled_at(&db, "test-app"), None);
}

#[tokio::test]
async fn under_scoped_callers_are_rejected_before_the_handler() {
    let (g, _owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);

    // Listing needs `Client.r`; a grants reader doesn't have it.
    let grants_reader = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let res = list_clients(&g, &grants_reader).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["wildflower/Client.r"]),
    );

    // Updating needs `Client.u`; reading clients isn't enough — and the gate
    // runs first, so even an unknown id is a 403, not a 404.
    let clients_reader = mint_scoped_token(&db, &["wildflower/Client.r"]);
    assert_eq!(
        list_clients(&g, &clients_reader).await.status(),
        StatusCode::OK
    );
    for (client_id, disabled_at) in [
        ("test-app", Value::from(Utc::now().to_rfc3339())),
        ("test-app", Value::Null),
        ("ghost", Value::from(Utc::now().to_rfc3339())),
    ] {
        let body = serde_json::json!({ "disabledAt": disabled_at });
        let res = patch_client(&g, &clients_reader, client_id, &body).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{client_id} {body}");
        assert_eq!(
            body_json(res.into_body()).await["missingScopes"],
            serde_json::json!(["wildflower/Client.u"]),
        );
    }
    assert_eq!(stored_disabled_at(&db, "test-app"), None);
}
