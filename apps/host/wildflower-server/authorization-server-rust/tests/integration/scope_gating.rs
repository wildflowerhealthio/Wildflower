//! Scope-gated authorization on `/authorization`: past the session gate, each
//! route takes the scopes its capability requires. A valid but under-scoped
//! token is a `403` naming the missing scope, before the handler runs; the
//! exact scope passes the gate; and a resource wildcard covers its resource,
//! the coverage engine driving real endpoints. Logout and the session read are
//! self-service and take no scope.

use crate::common::*;

/// A token holding exactly `wildflower/Grant.r` lists the grants.
#[tokio::test]
async fn access_grants_list_with_grant_read_scope_returns_200() {
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = build_request(
        Request::get("/authorization/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await, serde_json::json!([]));
}

/// `wildflower/*.cruds` covers `wildflower/Grant.r`, so a token holding the
/// Wildflower wildcard, though not the Owner's, passes the per-resource gate.
#[tokio::test]
async fn access_grants_list_with_wildflower_wildcard_returns_200() {
    // `wildflower/*.cruds` covers `wildflower/Grant.r` — a non-owner token that
    // holds the Wildflower wildcard still passes the per-resource gate.
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/*.cruds"]);
    let req = build_request(
        Request::get("/authorization/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

/// A read-only token is authenticated but may not revoke a grant: the gate
/// answers `403 InsufficientScope` naming `wildflower/Grant.d` before the
/// handler runs, so even an unknown id is a `403`, never a `404`.
#[tokio::test]
async fn access_grants_delete_with_only_read_scope_returns_403_missing_delete() {
    // A valid token scoped to read-only is authenticated (not a 401) but
    // unauthorized to revoke — the gate rejects with 403 BEFORE the handler, so
    // even a non-existent id is a 403, never a 404.
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = build_request(
        Request::delete("/authorization/grants/any-id")
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

/// `wildflower/Grant.d` clears the gate: the handler runs and answers the
/// unknown grant with `404 GrantNotFound`.
#[tokio::test]
async fn access_grants_delete_with_grant_delete_scope_passes_the_gate() {
    // The `Grant.d` scope clears the gate, so the handler runs and reports the
    // missing grant as a 404 — proving the gate admitted the request (not a 403).
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.d"]);
    let req = build_request(
        Request::delete("/authorization/grants/nope")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(res.into_body()).await["error"], "GrantNotFound");
}

/// Revoking tokens takes `wildflower/Token.d`: without it the call is `403`
/// naming that scope; with it a subject's epoch bump succeeds.
#[tokio::test]
async fn access_revocations_requires_token_delete_scope() {
    let (g, _owner_token, db) = spin_up();
    // A `Grant.r` token can't revoke tokens — 403 naming `wildflower/Token.d`.
    let under_scoped = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = build_request(
        Request::post("/authorization/revocations")
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
    let req = build_request(
        Request::post("/authorization/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {authorized}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"subject":"some-client"}"#),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}

/// Logout takes no admin scope: a token holding an unrelated, narrow scope
/// still logs itself out.
#[tokio::test]
async fn access_logout_is_self_service_any_valid_bearer() {
    // Logout takes no admin scope: a token with an unrelated, narrow scope still
    // logs itself out (303 redirect), because it only needs authN.
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = build_request(
        Request::post("/authorization/logout")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
}

/// `GET /authorization/session` takes no admin scope and reports the caller's
/// own scopes, so an under-scoped session arriving from a `403` can read what
/// it holds.
#[tokio::test]
async fn access_session_reports_the_callers_own_scopes_without_an_admin_scope() {
    // `GET /authorization/session` is self-service like logout: it reports back the
    // caller's *own* verified `scope` claim, so it takes no admin scope. That is
    // the point — the callers who need it are the under-scoped sessions arriving
    // from a 403, whom a scope gate would lock out of reading their own scopes.
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["patient/Observation.rs", "wildflower/Grant.r"]);
    let req = build_request(
        Request::get("/authorization/session")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "scopes": ["patient/Observation.rs", "wildflower/Grant.r"],
            "browserSessionExpiresAt": null,
        }),
    );
}

/// Without a token the session read is `401`, never a `200` with no scopes,
/// which would read as a session that holds nothing.
#[tokio::test]
async fn access_session_without_a_token_is_401_not_an_empty_scope_list() {
    // The `/authorization` authN gate still applies. An unauthenticated caller must get
    // a 401 — never a 200 with `[]`, which the device-login screen would read as
    // "this session holds nothing" rather than "there is no session".
    let (g, _owner_token, _db) = spin_up();
    let req = build_request(
        Request::get("/authorization/session").header("host", "127.0.0.1"),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
