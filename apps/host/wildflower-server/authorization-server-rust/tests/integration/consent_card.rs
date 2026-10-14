//! The consent card (#1099): `/oauth/authorize` sends a browser signed in as
//! the Owner to `/oauth/authorize/{id}/consent` and any other to the wait page,
//! and the card decides the request through the existing
//! `/authorization/oauth-consents/{id}` API on the Owner browser's bearer, the
//! token its session cookie holds. The cookie→bearer layer that presents that
//! token for the card is the host's (`wildflower-server-rust`), so these tests
//! send it as the bearer themselves.

use crate::common::*;

/// The scopes the test client registers and asks for.
const REQUESTED_SCOPES: &str = "patient%2FObservation.rs%20openid";

/// `GET /oauth/authorize` for the registered `test-app`, carrying `cookie`.
async fn authorize_with_cookie(g: &AuthorizationServer, cookie: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!(
                "/oauth/authorize?{}",
                authorize_query("test-app", REQUESTED_SCOPES)
            ))
            .header("cookie", cookie),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// The page a parked request's `Location` names (`wait` or `consent`), and
/// the request id before it.
fn parked_page(res: &axum::response::Response) -> (String, String) {
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = location_of(res);
    let resolved = Url::parse("https://ruth.relay.example/oauth/authorize")
        .and_then(|authorize| authorize.join(&location))
        .expect("the location resolves");
    let mut segments = resolved.path_segments().expect("an absolute path");
    let page = segments.next_back().expect("a page").to_owned();
    let request_id = segments.next_back().expect("a request id").to_owned();
    (page, request_id)
}

/// `POST /authorization/oauth-consents/{id}/{decision}` with `bearer` and `body`.
async fn decide(
    g: &AuthorizationServer,
    bearer: &str,
    request_id: &str,
    decision: &str,
    body: &'static str,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::post(format!(
                "/authorization/oauth-consents/{request_id}/{decision}"
            ))
            .header("authorization", format!("Bearer {bearer}"))
            .header("content-type", "application/json"),
            Body::from(body),
        ))
        .await
        .expect("oneshot")
}

/// The wait page's status poll for `request_id`, as JSON.
async fn status_of(g: &AuthorizationServer, request_id: &str) -> Value {
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await
}

/// A request from a browser signed in as the Owner, parked on the consent
/// card: the Owner browser token and the request id.
async fn parked_on_the_card(g: &AuthorizationServer) -> (String, String) {
    let owner_browser_token = signed_in_owner_browser_token(g).await;
    let res = authorize_with_cookie(
        g,
        &format!("__Host-owner_browser_session={owner_browser_token}"),
    )
    .await;
    let (page, request_id) = parked_page(&res);
    assert_eq!(page, "consent");
    (owner_browser_token, request_id)
}

#[tokio::test]
async fn a_browser_signed_in_as_the_owner_goes_to_the_consent_card() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let owner_browser_token = signed_in_owner_browser_token(&g).await;

    for cookie in [
        format!("__Host-owner_browser_session={owner_browser_token}"),
        format!("theme=dark; __Host-owner_browser_session={owner_browser_token}"),
    ] {
        let res = authorize_with_cookie(&g, &cookie).await;
        assert_eq!(parked_page(&res).0, "consent", "{cookie}");
    }
}

#[tokio::test]
async fn any_other_browser_goes_to_the_wait_page() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let revoked = signed_in_owner_browser_token(&g).await;
    revocation_store_handle(&db)
        .revoke_subject_as_of_now(wildflowerhealthio_authorization_server::OWNER_BROWSER_CLIENT_ID)
        .expect("revoke the Owner browser's subject");

    for cookie in [
        String::new(),
        "theme=dark".to_owned(),
        "__Host-owner_browser_session=not-a-token".to_owned(),
        format!("__Host-owner_browser_session={revoked}"),
        // The same token under another name is no Owner browser session.
        format!("owner_browser_session={revoked}"),
    ] {
        let res = authorize_with_cookie(&g, &cookie).await;
        assert_eq!(parked_page(&res).0, "wait", "{cookie:?}");
    }
}

#[tokio::test]
async fn approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let (owner_browser_token, request_id) = parked_on_the_card(&g).await;

    let res = decide(
        &g,
        &owner_browser_token,
        &request_id,
        "approve",
        r#"{"approvedScopes":["patient/Observation.rs","openid"],"patient":null,"acknowledgedRegistration":false}"#,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let decision = body_json(res.into_body()).await;
    assert_eq!(decision["status"], "approved");
    let redirect = Url::parse(decision["redirect"].as_str().expect("a redirect")).expect("a URL");
    assert_eq!(
        redirect.as_str().split('?').next(),
        Some("https://app.example/cb")
    );
    let query: std::collections::HashMap<_, _> = redirect.query_pairs().into_owned().collect();
    assert_eq!(query.get("state").map(String::as_str), Some("xyz"));
    assert!(query.contains_key("code"), "{redirect}");

    // A wait page left open on the request settles on the same callback.
    let status = status_of(&g, &request_id).await;
    assert_eq!(status["status"], "approved");
    assert_eq!(status["redirect"], decision["redirect"]);
}

#[tokio::test]
async fn a_scope_that_was_not_requested_is_not_granted() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let (owner_browser_token, request_id) = parked_on_the_card(&g).await;

    // The card can't add scopes; a hand-made approval that does gets only
    // what was requested.
    let res = decide(
        &g,
        &owner_browser_token,
        &request_id,
        "approve",
        r#"{"approvedScopes":["patient/Observation.rs","patient/Condition.rs"],"patient":null,"acknowledgedRegistration":false}"#,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let decision = body_json(res.into_body()).await;
    let redirect = Url::parse(decision["redirect"].as_str().expect("a redirect")).expect("a URL");
    let code = redirect
        .query_pairs()
        .find(|(name, _)| name == "code")
        .map(|(_, code)| code.into_owned())
        .expect("a code");

    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(format!(
                "grant_type=authorization_code&client_id=test-app&code={code}&\
                 code_verifier={CODE_VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"
            )),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let token = body_json(res.into_body()).await;
    assert_eq!(token["scope"], "patient/Observation.rs");
}

#[tokio::test]
async fn an_unacknowledged_new_registration_is_refused() {
    let (g, _host_owner_token, _db) = spin_up();
    // `test-app` is registered nowhere: the request is `new`.
    let (owner_browser_token, request_id) = parked_on_the_card(&g).await;

    let res = decide(
        &g,
        &owner_browser_token,
        &request_id,
        "approve",
        r#"{"approvedScopes":["patient/Observation.rs"],"patient":null,"acknowledgedRegistration":false}"#,
    )
    .await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(res.into_body()).await["error"],
        "RegistrationNotAcknowledged"
    );
    assert_eq!(status_of(&g, &request_id).await["status"], "pending");
}

#[tokio::test]
async fn denying_sends_access_denied_to_the_client_and_settles_the_wait_page() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs", "openid"],
    );
    let (owner_browser_token, request_id) = parked_on_the_card(&g).await;

    let res = decide(&g, &owner_browser_token, &request_id, "deny", "").await;
    assert_eq!(res.status(), StatusCode::OK);
    let decision = body_json(res.into_body()).await;
    assert_eq!(decision["status"], "denied");
    assert_eq!(
        decision["redirect"],
        "https://app.example/cb?error=access_denied&state=xyz"
    );

    let status = status_of(&g, &request_id).await;
    assert_eq!(status["status"], "denied");
    assert_eq!(status["redirect"], decision["redirect"]);
}

/// The card is served on the request's own path, under the wait page's
/// headers. Its scripts and stylesheets are pinned by
/// `authorization_pages.rs`'s unit tests against a build they define.
#[tokio::test]
async fn the_consent_card_is_locked_down_and_uncached() {
    let (g, _host_owner_token, _db) = spin_up();

    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/oauth/authorize/req-1/consent"),
            Body::empty(),
        ))
        .await
        .expect("oneshot");

    assert_eq!(res.status(), StatusCode::OK);
    let header = |name: &str| {
        res.headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_else(|| panic!("{name}"))
            .to_owned()
    };
    assert_eq!(header("content-type"), "text/html; charset=utf-8");
    assert_eq!(
        header("content-security-policy"),
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; \
         base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    assert_eq!(header("referrer-policy"), "no-referrer");
    assert_eq!(header("x-content-type-options"), "nosniff");
    assert_cache_suppressed(&res, "the consent card");
}
