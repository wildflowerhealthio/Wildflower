//! Both claims-inserting bearer gates stamp the verified OAuth client on the
//! response as a [`RequestCaller`] extension — the host's forwarded-request
//! observer reads it to say which app is using the server. A request the gate
//! rejects carries a [`RequestRefusal`] saying why instead, and a path it
//! exempts carries neither.

use crate::common::*;
use wildflowerhealthio_shared_structures::request_caller::{RequestCaller, RequestRefusal};

fn stamped_caller(response: &axum::response::Response) -> Option<RequestCaller> {
    response.extensions().get::<RequestCaller>().cloned()
}

fn stamped_refusal(response: &axum::response::Response) -> Option<RequestRefusal> {
    response.extensions().get::<RequestRefusal>().copied()
}

/// Revoke `token` by denylisting its `jti`.
fn revoke(db: &TestDb, token: &str) {
    revocation_store_handle(db)
        .revoke_jti(&jti_of(token), Utc::now() + Duration::hours(1), "test")
        .expect("revoke");
}

fn bearer_gated_router(g: &Gatekeeper) -> axum::Router {
    use axum::routing::get;
    use wildflowerhealthio_gatekeeper::gatekeeper_auth_middleware;

    axum::Router::new()
        .route("/fhir-r4/metadata", get(|| async { "ok" }))
        .route("/fhir-r4/Patient", get(|| async { "ok" }))
        .layer(gatekeeper_auth_middleware(
            g.state.clone(),
            &["/fhir-r4/metadata"],
        ))
}

fn get_with_bearer(path: &str, token: Option<&str>) -> Request<Body> {
    let mut builder = Request::get(path).header("host", "127.0.0.1");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    loopback_request(builder, Body::empty())
}

#[tokio::test]
async fn the_bearer_gate_stamps_the_token_s_client() {
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["patient/*.rs"]);

    let response = bearer_gated_router(&g)
        .oneshot(get_with_bearer("/fhir-r4/Patient", Some(&token)))
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

#[tokio::test]
async fn the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request() {
    let (g, _host_owner_token, _db) = spin_up();
    let router = bearer_gated_router(&g);

    let rejected = router
        .clone()
        .oneshot(get_with_bearer("/fhir-r4/Patient", None))
        .await
        .expect("oneshot");
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(stamped_caller(&rejected), None);

    let exempt = router
        .oneshot(get_with_bearer("/fhir-r4/metadata", None))
        .await
        .expect("oneshot");
    assert_eq!(exempt.status(), StatusCode::OK);
    assert_eq!(stamped_caller(&exempt), None);
}

#[tokio::test]
async fn the_session_gate_stamps_the_token_s_client() {
    let (g, host_owner_token, _db) = spin_up();

    let response = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        stamped_caller(&response),
        Some(RequestCaller {
            client_id: wildflowerhealthio_gatekeeper::default_first_party_client_id()
        })
    );
}

#[tokio::test]
async fn the_session_gate_stamps_nothing_on_a_rejected_request() {
    let (g, _host_owner_token, _db) = spin_up();

    let response = g
        .router
        .oneshot(owner_grants_probe("not-a-jwt"))
        .await
        .expect("oneshot");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(stamped_caller(&response), None);
}

#[tokio::test]
async fn the_bearer_gate_stamps_why_it_refused_each_401() {
    let (g, _host_owner_token, db) = spin_up();
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
            .oneshot(get_with_bearer("/fhir-r4/Patient", token))
            .await
            .expect("oneshot");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(stamped_refusal(&response), Some(refusal));
    }

    let exempt = router
        .oneshot(get_with_bearer("/fhir-r4/metadata", None))
        .await
        .expect("oneshot");
    assert_eq!(
        stamped_refusal(&exempt),
        None,
        "an exempt path is not refused"
    );
}

#[tokio::test]
async fn the_session_gate_stamps_why_it_refused_each_401() {
    let (g, host_owner_token, db) = spin_up();
    let no_token = loopback_request(
        Request::get("/access/grants").header("host", "127.0.0.1"),
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

    revoke(&db, &host_owner_token);
    let revoked = g
        .router
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(stamped_refusal(&revoked), Some(RequestRefusal::Revoked));
}

/// A token too narrow for the route is refused with a `403` after the gate
/// verified it, so the response names its caller and carries no refusal.
#[tokio::test]
async fn a_scope_refusal_carries_the_caller_and_no_refusal() {
    let (g, _host_owner_token, db) = spin_up();
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
