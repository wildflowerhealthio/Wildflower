//! The limit on starting authorization requests: every request to
//! `/oauth/authorize` (`HEAD` included) and `/oauth/device_authorization`
//! asks the host's `AuthorizationStartGate`, before it is parsed, and is
//! answered `429`, uncached, when the gate refuses. A browser whose session
//! can decide consents passes without asking, as does a browser without a
//! session at `/oauth/authorize`, which is only sent to pairing; no other
//! route asks.

use std::sync::atomic::{AtomicUsize, Ordering};

use axum::http::{header, Extensions, Method};

use crate::common::*;

/// The scopes the test client registers and asks for.
const REQUESTED_SCOPES: &str = "patient%2FObservation.rs%20openid";

/// A gate that admits its first `admitted` requests and refuses the rest,
/// counting how often it is asked.
struct CountingGate {
    admitted: usize,
    asked: AtomicUsize,
}

impl CountingGate {
    /// A gate that refuses every request.
    fn refusing() -> Arc<Self> {
        Arc::new(Self {
            admitted: 0,
            asked: AtomicUsize::new(0),
        })
    }

    /// How often the gate has been asked.
    fn asked(&self) -> usize {
        self.asked.load(Ordering::SeqCst)
    }
}

impl AuthorizationStartGate for CountingGate {
    fn admit(&self, _request_extensions: &Extensions) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst) < self.admitted
    }
}

/// `method path` on `g`'s router, carrying `cookie` when given.
async fn send(
    g: &AuthorizationServer,
    method: Method,
    path: &str,
    cookie: Option<&str>,
) -> axum::response::Response {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    g.router
        .clone()
        .oneshot(build_request(builder, Body::empty()))
        .await
        .expect("oneshot")
}

#[tokio::test]
async fn a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    let paired_browser_cookie = browser_session_cookie(&db.paired_browser_token);

    // Neither request is well-formed: admitted, each would be a `400`.
    for (method, path, cookie) in [
        (
            Method::GET,
            "/oauth/authorize",
            Some(paired_browser_cookie.as_str()),
        ),
        (Method::POST, "/oauth/device_authorization", None),
    ] {
        let res = send(&g, method, path, cookie).await;
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS, "{path}");
        assert_eq!(
            res.headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-store"),
            "{path}"
        );
        assert_eq!(
            body_string(res.into_body()).await,
            "too many authorization requests; try again later"
        );
    }
    assert_eq!(gate.asked(), 2);
}

#[tokio::test]
async fn head_authorize_asks_the_gate() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());

    let res = send(
        &g,
        Method::HEAD,
        "/oauth/authorize",
        Some(&browser_session_cookie(&db.paired_browser_token)),
    )
    .await;

    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(gate.asked(), 1);
}

#[tokio::test]
async fn an_admitted_start_is_served() {
    let gate = Arc::new(CountingGate {
        admitted: 1,
        asked: AtomicUsize::new(0),
    });
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());

    let res = send(
        &g,
        Method::GET,
        "/oauth/authorize",
        Some(&browser_session_cookie(&db.paired_browser_token)),
    )
    .await;

    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(gate.asked(), 1);
}

#[tokio::test]
async fn a_browser_signed_in_as_the_owner_passes_without_asking_the_gate() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let owner_session_token = signed_in_owner_session_token(&g).await;
    let authorize = format!(
        "/oauth/authorize?{}",
        authorize_query("test-app", REQUESTED_SCOPES)
    );

    let res = send(
        &g,
        Method::GET,
        &authorize,
        Some(&format!("__Host-browser_session={owner_session_token}")),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(gate.asked(), 0);
}

/// A browser without a session, or whose cookie holds no live session, is
/// only sent to pairing by `/oauth/authorize`, so it passes without asking
/// the gate: a flood of them can't spend the allowance a paired browser's
/// requests need. A device authorization without a session still asks.
#[tokio::test]
async fn a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let authorize = format!(
        "/oauth/authorize?{}",
        authorize_query("test-app", REQUESTED_SCOPES)
    );

    for cookie in [None, Some("__Host-browser_session=not-a-token")] {
        let res = send(&g, Method::GET, &authorize, cookie).await;
        assert_eq!(res.status(), StatusCode::FOUND, "{cookie:?}");
        assert!(
            location_of(&res).starts_with("pair?next="),
            "{cookie:?} is sent to pairing"
        );
    }
    assert_eq!(gate.asked(), 0);

    let res = send(&g, Method::POST, "/oauth/device_authorization", None).await;
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(gate.asked(), 1);
}

#[tokio::test]
async fn a_browser_session_that_cannot_decide_consents_asks_the_gate() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let session_token = signed_in_session_token_that_cannot_decide(&g, &db).await;

    let res = send(
        &g,
        Method::GET,
        &format!(
            "/oauth/authorize?{}",
            authorize_query("test-app", REQUESTED_SCOPES)
        ),
        Some(&format!("__Host-browser_session={session_token}")),
    )
    .await;
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(gate.asked(), 1);
}

#[tokio::test]
async fn no_other_route_asks_the_gate() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, _db) = spin_up_with_authorization_start_gate(gate.clone());

    for (method, path) in [
        (Method::POST, "/oauth/token"),
        (Method::GET, "/oauth/authorize/request-id"),
        (Method::GET, "/oauth/authorize/request-id/wait"),
        (Method::GET, "/.well-known/jwks.json"),
    ] {
        let res = send(&g, method, path, None).await;
        assert_ne!(res.status(), StatusCode::TOO_MANY_REQUESTS, "{path}");
    }
    assert_eq!(gate.asked(), 0);
}
