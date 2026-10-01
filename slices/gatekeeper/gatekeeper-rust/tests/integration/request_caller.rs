//! Both claims-inserting bearer gates stamp the verified OAuth client on the
//! response as a [`RequestCaller`] extension — the host's forwarded-request
//! observer reads it to say which app is using the server. A request the gate
//! rejects, or a path it exempts, carries none.

use crate::common::*;
use shared_structures_rust::request_caller::RequestCaller;

fn stamped_caller(response: &axum::response::Response) -> Option<RequestCaller> {
    response.extensions().get::<RequestCaller>().cloned()
}

fn bearer_gated_router(g: &Gatekeeper) -> axum::Router {
    use axum::routing::get;
    use gatekeeper_rust::gatekeeper_auth_middleware;

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
        Some(RequestCaller::OAuthClient {
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
        Some(RequestCaller::OAuthClient {
            client_id: gatekeeper_rust::default_first_party_client_id()
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
