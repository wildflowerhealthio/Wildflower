//! Both claims-inserting bearer gates stamp the verified OAuth client on the
//! response as a [`RequestCaller`] extension — the host's forwarded-request
//! observer reads it to say which app is using the server. A request the gate
//! rejects carries a [`RequestRefusal`] saying why instead, and a path it
//! exempts carries neither.

use crate::common::*;
use wildflowerhealthio_shared_structures::request_caller::{RequestCaller, RequestRefusal};

/// The client a gate stamped on `response` as its caller, if any.
fn stamped_caller(response: &axum::response::Response) -> Option<RequestCaller> {
    response.extensions().get::<RequestCaller>().cloned()
}

/// Why a gate stamped `response` as refused, if it did.
fn stamped_refusal(response: &axum::response::Response) -> Option<RequestRefusal> {
    response.extensions().get::<RequestRefusal>().copied()
}

/// Revoke `token` by denylisting its `jti`.
fn revoke(db: &TestDb, token: &str) {
    revocation_store_handle(db)
        .revoke_jti(
            &jti_of(token),
            Utc::now(),
            Utc::now() + Duration::hours(1),
            "test",
        )
        .expect("revoke");
}

/// A router of two stub routes behind the bearer gate the FHIR server uses:
/// `/Patient`, which is gated, and `/metadata`, which the gate exempts.
fn bearer_gated_router(g: &AuthorizationServer) -> axum::Router {
    use axum::routing::get;
    use wildflowerhealthio_authorization_server::authorization_server_auth_middleware;

    axum::Router::new()
        .route("/metadata", get(|| async { "ok" }))
        .route("/Patient", get(|| async { "ok" }))
        .layer(authorization_server_auth_middleware(
            g.state.clone(),
            &["/metadata"],
        ))
}

/// `GET path`, with `token` as its bearer when given.
fn get_with_bearer(path: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::get(path).header("host", "127.0.0.1");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    build_request(builder, Body::empty())
}

/// A request the bearer gate admits carries the verified token's client as its
/// caller.
#[tokio::test]
async fn the_bearer_gate_stamps_the_token_s_client() {
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["patient/*.rs"]);

    let response = bearer_gated_router(&g)
        .oneshot(get_with_bearer("/Patient", Some(&token)))
        .await
        .expect("oneshot");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        stamped_caller(&response),
        Some(RequestCaller {
            client_id: "scoped-app".to_owned()
        })
    );
}

/// A request the bearer gate rejects, or a path it exempts, carries no caller.
#[tokio::test]
async fn the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request() {
    let (g, _owner_token, _db) = spin_up();
    let router = bearer_gated_router(&g);

    let rejected = router
        .clone()
        .oneshot(get_with_bearer("/Patient", None))
        .await
        .expect("oneshot");
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(stamped_caller(&rejected), None);

    let exempt = router
        .oneshot(get_with_bearer("/metadata", None))
        .await
        .expect("oneshot");
    assert_eq!(exempt.status(), StatusCode::OK);
    assert_eq!(stamped_caller(&exempt), None);
}

/// A request the `/authorization` session gate admits carries the verified
/// token's client as its caller.
#[tokio::test]
async fn the_session_gate_stamps_the_token_s_client() {
    let (g, owner_token, _db) = spin_up();

    let response = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&owner_token))
        .await
        .expect("oneshot");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        stamped_caller(&response),
        Some(RequestCaller {
            client_id: OWNER_TOKEN_CLIENT_ID.to_owned()
        })
    );
}

/// A request the `/authorization` session gate rejects carries no caller.
#[tokio::test]
async fn the_session_gate_stamps_nothing_on_a_rejected_request() {
    let (g, _owner_token, _db) = spin_up();

    let response = g
        .router
        .oneshot(owner_grants_probe("not-a-jwt"))
        .await
        .expect("oneshot");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(stamped_caller(&response), None);
}

/// Each `401` from the bearer gate says why: no token, a token that doesn't
/// verify, or a revoked one. An exempt path carries no refusal.
#[tokio::test]
async fn the_bearer_gate_stamps_why_it_refused_each_401() {
    let (g, _owner_token, db) = spin_up();
    let router = bearer_gated_router(&g);
    let revoked_token = mint_scoped_token(&db, &["patient/*.rs"]);
    revoke(&db, &revoked_token);

    for (token, refusal) in [
        (None, RequestRefusal::MissingToken),
        (Some("not-a-jwt"), RequestRefusal::TokenRejected),
        (Some(revoked_token.as_str()), RequestRefusal::Revoked),
    ] {
        let response = router
            .clone()
            .oneshot(get_with_bearer("/Patient", token))
            .await
            .expect("oneshot");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(stamped_refusal(&response), Some(refusal));
    }

    let exempt = router
        .oneshot(get_with_bearer("/metadata", None))
        .await
        .expect("oneshot");
    assert_eq!(
        stamped_refusal(&exempt),
        None,
        "an exempt path is not refused"
    );
}

/// Each `401` from the `/authorization` session gate says why: no token, a
/// token that doesn't verify, or a revoked one.
#[tokio::test]
async fn the_session_gate_stamps_why_it_refused_each_401() {
    let (g, owner_token, db) = spin_up();
    let no_token = build_request(
        Request::get("/authorization/grants").header("host", "127.0.0.1"),
        Body::empty(),
    );
    let missing = g.router.clone().oneshot(no_token).await.expect("oneshot");
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        stamped_refusal(&missing),
        Some(RequestRefusal::MissingToken)
    );

    let rejected = g
        .router
        .clone()
        .oneshot(owner_grants_probe("not-a-jwt"))
        .await
        .expect("oneshot");
    assert_eq!(
        stamped_refusal(&rejected),
        Some(RequestRefusal::TokenRejected)
    );

    revoke(&db, &owner_token);
    let revoked = g
        .router
        .oneshot(owner_grants_probe(&owner_token))
        .await
        .expect("oneshot");
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(stamped_refusal(&revoked), Some(RequestRefusal::Revoked));
}

/// A token too narrow for the route is refused with a `403` after the gate
/// verified it, so the response names its caller and carries no refusal.
#[tokio::test]
async fn a_scope_refusal_carries_the_caller_and_no_refusal() {
    let (g, _owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["patient/*.rs"]);

    let response = g
        .router
        .oneshot(owner_grants_probe(&token))
        .await
        .expect("oneshot");

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        stamped_caller(&response),
        Some(RequestCaller {
            client_id: "scoped-app".to_owned()
        })
    );
    assert_eq!(stamped_refusal(&response), None);
}
