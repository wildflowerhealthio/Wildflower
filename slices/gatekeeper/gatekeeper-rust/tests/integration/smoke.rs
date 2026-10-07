use crate::common::*;

#[tokio::test]
async fn jwks_endpoint_returns_seeded_key() {
    let (g, _host_owner_token, _db) = spin_up();
    let req = loopback_request(Request::get("/.well-known/jwks.json"), Body::empty());
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    // The kid/n/e are key-material-derived, so thread them through from the
    // actual key; everything else (kty/alg/key_ops and — crucially — the
    // *absence* of any private field like d/p/q) is pinned by comparing the
    // entire body against one literal.
    let key = &body["keys"][0];
    let kid = key["kid"].clone();
    let n = key["n"].clone();
    let e = key["e"].clone();
    assert_eq!(
        body,
        serde_json::json!({
            "keys": [{
                "kid": kid,
                "kty": "RSA",
                "alg": "RS256",
                "key_ops": ["verify"],
                "n": n,
                "e": e,
            }]
        })
    );
}

#[tokio::test]
async fn bearer_gate_exempts_listed_paths_but_gates_the_rest() {
    use axum::routing::get;
    use axum::Router;
    use gatekeeper_rust::gatekeeper_auth_middleware;

    let (g, _host_owner_token, _db) = spin_up();
    // A trivial downstream router wrapped in the bearer gate with only the
    // discovery path exempted — exercises the real middleware wiring (full path,
    // exact match) rather than just the `is_exempt` helper.
    let inner = Router::new()
        .route("/fhir-r4/metadata", get(|| async { "ok" }))
        .route("/fhir-r4/metadata-x", get(|| async { "ok" }))
        .route("/fhir-r4/Patient", get(|| async { "ok" }));
    let gated = inner.layer(gatekeeper_auth_middleware(
        g.state.clone(),
        &["/fhir-r4/metadata"],
    ));

    let status = |path: &'static str| {
        let gated = gated.clone();
        async move {
            gated
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .expect("oneshot")
                .status()
        }
    };

    // Exempt path: served without any bearer token.
    assert_eq!(status("/fhir-r4/metadata").await, StatusCode::OK);
    // A path that merely shares a prefix is NOT exempt — still gated.
    assert_eq!(
        status("/fhir-r4/metadata-x").await,
        StatusCode::UNAUTHORIZED
    );
    // A normal resource path is gated — 401 without a token.
    assert_eq!(status("/fhir-r4/Patient").await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bearer_gate_inserts_scope_claims_a_downstream_capability_reads() {
    // Cross-slice contract: the databases router's per-database scope gate only
    // works because gatekeeper's bearer gate inserts a `ScopeClaims` into the
    // request extensions. Drive the real producer (the gate) and the real
    // consumer (databases' `Scoped<DatabasesReader>`) together — if the gate ever
    // stopped inserting `ScopeClaims`, every gated `/databases` request would 500
    // instead of 200/403, and only this test would catch it (the slice's own
    // tests fabricate the extension).
    use gatekeeper_rust::gatekeeper_auth_middleware;

    let (g, host_owner_token, db) = spin_up();

    // A one-database catalogue gated by `wildflower/*` read/delete, backed by a
    // real on-disk SQLite file so the metadata read + snapshot have something to
    // work against.
    let dir = tempfile::tempdir().expect("tempdir");
    let db_id = "wildflower.sqlite";
    {
        let conn = rusqlite::Connection::open(dir.path().join(db_id)).expect("seed db");
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);")
            .expect("seed table");
    }
    let config = databases_rust::DatabasesConfig {
        data_dir: dir.path().to_path_buf(),
        databases: vec![databases_rust::DatabaseDescriptor {
            id: db_id.to_owned(),
            label: "Wildflower app data".to_owned(),
            description: "App state.".to_owned(),
            read_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::READ),
            delete_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::DELETE),
        }],
    };
    let gated = databases_rust::setup_databases(&config)
        .layer(gatekeeper_auth_middleware(g.state.clone(), &[]));

    let get = |path: String, token: Option<String>| {
        let gated = gated.clone();
        async move {
            let mut builder = Request::get(&path);
            if let Some(token) = token {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            gated
                .oneshot(loopback_request(builder, Body::empty()))
                .await
                .expect("oneshot")
                .status()
        }
    };

    // No token → 401 at the gate, before any capability runs.
    assert_eq!(
        get(format!("/databases/{db_id}"), None).await,
        StatusCode::UNAUTHORIZED,
    );
    // Owner token (covers `wildflower/*`) → the capability builds and streams the
    // snapshot: proof the gate inserted a `ScopeClaims` the extractor could read.
    assert_eq!(
        get(format!("/databases/{db_id}"), Some(host_owner_token)).await,
        StatusCode::OK,
    );
    // A valid token that does NOT cover the database's read scope → 403 from the
    // capability (NOT a 500): the extractor read the inserted claims and found
    // them insufficient.
    let under_scoped = mint_scoped_token(&db, &["system/Observation.r"]);
    assert_eq!(
        get(format!("/databases/{db_id}"), Some(under_scoped)).await,
        StatusCode::FORBIDDEN,
    );
}

#[tokio::test]
async fn access_grants_without_auth_returns_401() {
    let (g, _host_owner_token, _db) = spin_up();
    let req = loopback_request(Request::get("/access/grants"), Body::empty());
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn access_grants_with_owner_token_returns_empty_list() {
    let (g, host_owner_token, _db) = spin_up();
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert_eq!(body, serde_json::json!([]));
}

/// The host owner token authenticates on a FORWARDED (tunnel-origin) request
/// too, where the served origin is the tunnel public host, not loopback: its
/// `iss` and `aud` are the server's origin, checked against the server's
/// configuration rather than the request.
#[tokio::test]
async fn access_grants_with_owner_token_passes_on_forwarded_tunnel_origin() {
    let (g, host_owner_token, _db) = spin_up();
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header(
                "forwarded",
                "host=ruth.wildflowerhealth.example;proto=https",
            )
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

/// `GET /access/grants` with `token`, over loopback or relayed through the
/// tunnel.
async fn access_grants_status(g: &Gatekeeper, token: &str, forwarded: bool) -> StatusCode {
    let mut builder = Request::get("/access/grants")
        .header("host", "127.0.0.1")
        .header("authorization", format!("Bearer {token}"));
    if forwarded {
        builder = builder.header("forwarded", "host=ruth.relay.example;proto=https");
    }
    let req = loopback_request(builder, Body::empty());
    g.router
        .clone()
        .oneshot(req)
        .await
        .expect("oneshot")
        .status()
}

/// A token minted for this server is accepted whichever origin the request was
/// served on: over loopback and relayed through the tunnel alike.
#[tokio::test]
async fn a_token_for_this_server_passes_over_loopback_and_the_tunnel() {
    let (g, _host_owner_token, db) = spin_up();
    let owner_scopes: Vec<String> = gatekeeper_rust::default_local_granted_scopes();
    let owner_scopes: Vec<&str> = owner_scopes.iter().map(String::as_str).collect();
    let token = mint_scoped_token(&db, &owner_scopes);
    for forwarded in [false, true] {
        assert_eq!(
            access_grants_status(&g, &token, forwarded).await,
            StatusCode::OK,
            "forwarded: {forwarded}"
        );
    }
}

/// A token another server minted is refused, owner scopes and all, even signed
/// with a key this server holds: its `iss` and `aud` name the other server.
/// So is a token naming another server as only one of the two, and one whose
/// `aud` is this server's FHIR base rather than its origin.
#[tokio::test]
async fn a_token_not_naming_this_server_as_iss_and_aud_is_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    let other_server = "https://lab.relay.example";
    let fhir_base = format!("{SERVER_ORIGIN}/fhir-r4");
    let owner_scopes: Vec<String> = gatekeeper_rust::default_local_granted_scopes();
    let owner_scopes: Vec<&str> = owner_scopes.iter().map(String::as_str).collect();
    for (issuer, audience) in [
        (other_server, other_server),
        (other_server, SERVER_ORIGIN),
        (SERVER_ORIGIN, other_server),
        (SERVER_ORIGIN, fhir_base.as_str()),
    ] {
        let token = mint_token_naming(&db, &owner_scopes, issuer, audience);
        for forwarded in [false, true] {
            assert_eq!(
                access_grants_status(&g, &token, forwarded).await,
                StatusCode::UNAUTHORIZED,
                "iss {issuer}, aud {audience}, forwarded: {forwarded}"
            );
        }
    }
}

#[tokio::test]
async fn get_unknown_grant_returns_404() {
    let (g, host_owner_token, _db) = spin_up();
    let req = loopback_request(
        Request::get("/access/grants/nope")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "GrantNotFound");
}
