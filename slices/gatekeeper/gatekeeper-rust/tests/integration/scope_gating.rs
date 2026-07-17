use crate::common::*;

// --- Scope-gated `/access` authorization (resource-based authz, #261) ---------
//
// authN (a valid token) is proven above via 401; these pin authZ: a valid but
// under-scoped token is a 403 naming the missing scope, the exact-scope token
// passes the gate, and a resource wildcard covers its resource — the coverage
// engine driving real endpoints.

#[tokio::test]
async fn access_grants_list_with_grant_read_scope_returns_200() {
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await, serde_json::json!([]));
}

#[tokio::test]
async fn access_grants_list_with_wildflower_wildcard_returns_200() {
    // `wildflower/*.cruds` covers `wildflower/Grant.r` — a non-owner token that
    // holds the Wildflower wildcard still passes the per-resource gate.
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/*.cruds"]);
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn access_grants_delete_with_only_read_scope_returns_403_missing_delete() {
    // A valid token scoped to read-only is authenticated (not a 401) but
    // unauthorized to revoke — the gate rejects with 403 BEFORE the handler, so
    // even a non-existent id is a 403, never a 404.
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::delete("/access/grants/any-id")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "InsufficientScope");
    assert_eq!(
        body["missingScopes"],
        serde_json::json!(["wildflower/Grant.d"]),
    );
}

#[tokio::test]
async fn access_grants_delete_with_grant_delete_scope_passes_the_gate() {
    // The `Grant.d` scope clears the gate, so the handler runs and reports the
    // missing grant as a 404 — proving the gate admitted the request (not a 403).
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.d"]);
    let req = loopback_request(
        Request::delete("/access/grants/nope")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(res.into_body()).await["error"], "GrantNotFound");
}

#[tokio::test]
async fn access_revocations_requires_token_delete_scope() {
    let (g, _host_owner_token, db) = spin_up();
    // A `Grant.r` token can't revoke tokens — 403 naming `wildflower/Token.d`.
    let under_scoped = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::post("/access/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {under_scoped}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"subject":"some-client"}"#),
    );
    let res = g.router.clone().oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["wildflower/Token.d"]),
    );

    // A `Token.d` token clears the gate and the subject epoch bump succeeds.
    let authorized = mint_scoped_token(&db, &["wildflower/Token.d"]);
    let req = loopback_request(
        Request::post("/access/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {authorized}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"subject":"some-client"}"#),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn access_logout_is_self_service_any_valid_bearer() {
    // Logout takes no admin scope: a token with an unrelated, narrow scope still
    // logs itself out (303 redirect), because it only needs authN.
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::post("/access/logout")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
}
