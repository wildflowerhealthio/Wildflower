//! The limit on starting authorization requests.
//!
//! Anyone who knows the server's domain can start an authorization request,
//! and every request raised for the Owner pops up on the Owner's device. So
//! the host keeps a limit, its `AuthorizationStartGate`: every start that may
//! bother the Owner spends from the limit once, and a start the limit refuses
//! is `429`, uncached, and parks nothing.
//!
//! The limit sits on `/oauth/authorize` (`HEAD` included) and
//! `/oauth/device_authorization` only; no other route asks the gate. When a
//! start asks depends on what it carries:
//!
//! - A live browser session that can decide consents, at `/oauth/authorize`,
//!   asks only when its request is to be raised for the Owner or parked for
//!   the limited page. One it decides on its own consent card spends nothing,
//!   and going on past the limited page (`…/continue`) asks nothing more.
//! - No live browser session, at `/oauth/authorize`, never asks: the browser
//!   is only sent to pairing.
//! - Anything else, and every device-authorization start, asks at once,
//!   before the request is parsed.
//!
//! Asking the Owner about a request already parked (`…/ask-owner`) spends from
//! the same limit, when it raises the request.

use std::sync::atomic::{AtomicUsize, Ordering};

use axum::http::{header, Extensions, Method};

use crate::common::*;

/// The scopes the test client registers and asks for.
const REQUESTED_SCOPES: &str = "patient%2FObservation.rs%20openid";

/// A gate that admits its first `admitted` requests and refuses the rest,
/// counting how often it is asked.
struct CountingGate {
    /// How many of the first requests the gate admits.
    admitted: usize,
    /// How many times the gate has been asked so far.
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

/// A refused start is `429`, uncached, on either route, before the request is
/// parsed: both requests here are malformed, and admitted each would be a
/// `400`.
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

/// `HEAD /oauth/authorize` asks the gate like `GET`.
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

/// An admitted start goes on to the route, which here answers the malformed
/// request with `400`.
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

/// A request the Owner's browser decides on its own consent card spends
/// nothing from the limit: nobody else is bothered.
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
    let same_device_session_token = signed_in_same_device_session_token(&g).await;
    let authorize = format!(
        "/oauth/authorize?{}",
        authorize_query("test-app", REQUESTED_SCOPES)
    );

    let res = send(
        &g,
        Method::GET,
        &authorize,
        Some(&format!(
            "__Host-browser_session={same_device_session_token}"
        )),
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

/// A browser whose session can't decide consents asks the gate at once, and a
/// refusal is `429`.
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

/// No other route asks the gate: the token endpoint, the request and wait
/// pages, and the JWKS are never limited.
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

/// A browser whose session can decide consents but lacks a request's
/// approval scopes can't decide that request in place, so it is raised for
/// the Owner, and the start asks the gate then: refused, nothing is parked.
#[tokio::test]
async fn a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let same_device_session_token = signed_in_same_device_session_token(&g).await;
    let sid = decode_jwt_payload(&same_device_session_token)["sid"]
        .as_str()
        .expect("a browser session's token names its sid")
        .to_owned();
    // Decides consents, but can't create the grant an approval records; it
    // holds all the request asks for, so it doesn't stop at the limited page.
    let session_token = mint_browser_session_token(
        &db,
        &sid,
        &[
            "wildflower/AuthorizationRequest.r",
            "wildflower/AuthorizationRequest.u",
            "system/*.cruds",
        ],
    );

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
    assert!(owner_prompt(&db).is_none(), "nothing was parked");
}

/// A deciding browser whose session falls short of the request asks the
/// gate, which its start deferred, before the request parks for the limited
/// page; admitted, going on past the page raises the request for the Owner
/// without asking again. Refused, a request for another app parks nothing.
#[tokio::test]
async fn a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate() {
    let gate = Arc::new(CountingGate {
        admitted: 1,
        asked: AtomicUsize::new(0),
    });
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let same_device_session_token = signed_in_same_device_session_token(&g).await;
    let sid = decode_jwt_payload(&same_device_session_token)["sid"]
        .as_str()
        .expect("a browser session's token names its sid")
        .to_owned();
    let deciding_scopes = [
        "wildflower/AuthorizationRequest.r",
        "wildflower/AuthorizationRequest.u",
    ];
    let session_token = mint_browser_session_token(&db, &sid, &deciding_scopes);
    narrow_browser_session_of(&db, &session_token, &deciding_scopes);
    let query = authorize_query("test-app", REQUESTED_SCOPES);

    let request_id = limited_request_id(&get_authorize(&g.router, &session_token, &query).await);
    assert_eq!(gate.asked(), 1);
    let location = continue_past_session_shortfall(&g.router, &session_token, &request_id).await;
    assert_eq!(location, format!("/oauth/authorize/{request_id}/wait"));
    assert_eq!(gate.asked(), 1, "going on asks nothing");

    seed_client_with_redirect(
        &db,
        "other-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let res = get_authorize(
        &g.router,
        &session_token,
        &authorize_query("other-app", REQUESTED_SCOPES),
    )
    .await;
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(gate.asked(), 2);
}

/// A browser that can't decide consents spent its start at
/// `/oauth/authorize`, so going on past the limited page doesn't ask the
/// gate again.
#[tokio::test]
async fn a_continue_whose_start_was_counted_does_not_ask_the_gate_again() {
    let gate = Arc::new(CountingGate {
        admitted: 1,
        asked: AtomicUsize::new(0),
    });
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let (_, session_token) = paired_browser_session_holding(&db, &["wildflower/launch"]);

    let request_id = limited_request_id(
        &get_authorize(
            &g.router,
            &session_token,
            &authorize_query("test-app", REQUESTED_SCOPES),
        )
        .await,
    );
    assert_eq!(gate.asked(), 1);
    let location = continue_past_session_shortfall(&g.router, &session_token, &request_id).await;
    assert_eq!(location, format!("/oauth/authorize/{request_id}/wait"));
    assert_eq!(gate.asked(), 1);
}

/// Every device request is raised for the Owner, so even a browser signed in
/// as the Owner asks the gate to start one.
#[tokio::test]
async fn a_device_start_asks_the_gate_whatever_the_browser_session() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, _db) = spin_up_with_authorization_start_gate(gate.clone());
    let same_device_session_token = signed_in_same_device_session_token(&g).await;

    let res = send(
        &g,
        Method::POST,
        "/oauth/device_authorization",
        Some(&format!(
            "__Host-browser_session={same_device_session_token}"
        )),
    )
    .await;
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(gate.asked(), 1);
}

/// A browser signed in as the Owner starts a code request for `new-app`,
/// which it decides on its own consent card: the session's token and the
/// request's id.
async fn owner_decided_request(g: &AuthorizationServer) -> (String, String) {
    let same_device_session_token = signed_in_same_device_session_token(g).await;
    let res = send(
        g,
        Method::GET,
        &format!(
            "/oauth/authorize?{}",
            authorize_query("new-app", REQUESTED_SCOPES)
        ),
        Some(&format!(
            "__Host-browser_session={same_device_session_token}"
        )),
    )
    .await;
    let location = location_of(&res);
    assert!(location.ends_with("/consent"), "{location}");
    let request_id = location
        .trim_start_matches("authorize/")
        .trim_end_matches("/consent")
        .to_owned();
    (same_device_session_token, request_id)
}

/// `POST /authorization/oauth-consents/{request_id}/ask-owner` as `token`.
async fn ask_owner(g: &AuthorizationServer, token: &str, request_id: &str) -> StatusCode {
    g.router
        .clone()
        .oneshot(build_request(
            Request::post(format!(
                "/authorization/oauth-consents/{request_id}/ask-owner"
            ))
            .header(header::AUTHORIZATION, format!("Bearer {token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
        .status()
}

/// Whether the Owner prompt, which must be the code request, is decidable in
/// its requesting browser.
fn is_decidable_in_requesting_browser(db: &TestDb) -> bool {
    match owner_prompt(db) {
        Some(OwnerPrompt::AuthorizationCode {
            decidable_in_requesting_browser,
            ..
        }) => decidable_in_requesting_browser,
        other => panic!("expected the code request pending, got {other:?}"),
    }
}

/// Asking the Owner about a request raises it for the Owner, so it spends
/// from the limit like a start the Owner is asked about: refused, it is
/// `429` and the request stays decidable in its browser.
#[tokio::test]
async fn asking_the_owner_is_refused_by_the_limit_and_raises_nothing() {
    let gate = CountingGate::refusing();
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    let (same_device_session_token, request_id) = owner_decided_request(&g).await;
    assert_eq!(
        gate.asked(),
        0,
        "a request decided in its browser spends nothing"
    );

    assert_eq!(
        ask_owner(&g, &same_device_session_token, &request_id).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(gate.asked(), 1);
    assert!(is_decidable_in_requesting_browser(&db), "left as it was");
}

/// Admitted, asking the Owner raises the request; asking again about the
/// request already raised spends nothing.
#[tokio::test]
async fn asking_the_owner_spends_only_when_it_raises_a_request() {
    let gate = Arc::new(CountingGate {
        admitted: 1,
        asked: AtomicUsize::new(0),
    });
    let (g, _owner_token, db) = spin_up_with_authorization_start_gate(gate.clone());
    let (same_device_session_token, request_id) = owner_decided_request(&g).await;

    assert_eq!(
        ask_owner(&g, &same_device_session_token, &request_id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(gate.asked(), 1);
    assert!(!is_decidable_in_requesting_browser(&db), "raised");

    assert_eq!(
        ask_owner(&g, &same_device_session_token, &request_id).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(gate.asked(), 1, "already raised: nothing spent");
}
