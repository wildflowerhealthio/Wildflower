use crate::common::*;

/// Happy path for `client_secret_basic`: credentials only in the header, the
/// grant redeems and mints a token (RFC 6749 §2.3.1).
#[tokio::test]
async fn token_exchange_with_basic_auth_redeems_refresh_token() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["token_type"], "Bearer");
    assert!(!body["access_token"]
        .as_str()
        .expect("access_token")
        .is_empty());
}

/// A failed Basic attempt answers 401 with a matching `WWW-Authenticate:
/// Basic` challenge (RFC 6749 §5.2) — and stays cache-suppressed.
#[tokio::test]
async fn token_exchange_wrong_basic_secret_returns_401_with_basic_challenge() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, "not-the-secret"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        res.headers()
            .get("www-authenticate")
            .map(|v| v.to_str().unwrap()),
        Some(r#"Basic realm="gatekeeper""#)
    );
    assert_eq!(
        res.headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_client",
            "error_description": "Invalid client_secret",
        })
    );
}

/// A failed `client_secret_post` attempt is still 401 but carries NO Basic
/// challenge — the client never used the Authorization header (RFC 6749 §5.2
/// only mandates the challenge for header-based attempts).
#[tokio::test]
async fn token_exchange_body_secret_failure_has_no_basic_challenge() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=conf-app&client_secret=not-the-secret&refresh_token=conf-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(res.headers().get("www-authenticate"), None);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_client",
            "error_description": "Invalid client_secret",
        })
    );
}

/// Presenting a secret via Basic AND the body is two authentication methods
/// in one request — rejected per RFC 6749 §2.3, even when both are correct.
#[tokio::test]
async fn token_exchange_basic_plus_body_secret_returns_400_invalid_request() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        format!(
            "grant_type=refresh_token&client_secret={CONFIDENTIAL_CLIENT_SECRET}&refresh_token=conf-token"
        ),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_request",
            "error_description": "Multiple client authentication methods presented",
        })
    );
}

/// A body `client_id` contradicting the Basic userid is `invalid_request`.
#[tokio::test]
async fn token_exchange_basic_with_mismatched_body_client_id_returns_400_invalid_request() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=other-app&refresh_token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_request",
            "error_description": "client_id does not match Basic authorization header",
        })
    );
}

/// A body `client_id` that matches the Basic userid is tolerated — common
/// client-library behavior, and not a second authentication method.
#[tokio::test]
async fn token_exchange_basic_with_matching_body_client_id_succeeds() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        format!(
            "grant_type=refresh_token&client_id={CONFIDENTIAL_CLIENT_ID}&refresh_token=conf-token"
        ),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// `client_secret_post` keeps working for confidential clients (RFC 6749
/// §2.3.1 "MAY support including the client credentials in the request-body").
#[tokio::test]
async fn token_exchange_client_secret_post_still_authenticates_confidential_client() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=conf-app&client_secret=shhh-integration-secret&refresh_token=conf-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// No Basic header and no body `client_id` — there is no client to
/// authenticate, so the request itself is malformed.
#[tokio::test]
async fn token_exchange_missing_client_id_returns_400_invalid_request() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_request",
            "error_description": "Missing client_id",
        })
    );
}

/// RFC 6749 §2.3.1 form-urlencodes each Basic half before base64: a secret
/// full of reserved characters survives the encode/decode round trip.
#[tokio::test]
async fn token_exchange_basic_secret_with_reserved_characters_round_trips() {
    let (g, _host_owner_token, db) = spin_up();
    seed_confidential_client(
        &db,
        "conf-app",
        "p@ss word:100%&yes",
        &["read", "offline_access"],
    );
    plant_refresh_token(
        &store_handle(&db),
        "conf-token",
        "conf-app",
        Utc::now() + Duration::days(30),
    );
    // "p@ss word:100%&yes" form-urlencoded → "p%40ss+word%3A100%25%26yes"
    let authorization = format!(
        "Basic {}",
        base64::standard_encode("conf-app:p%40ss+word%3A100%25%26yes".as_bytes())
    );
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token".to_string(),
        &authorization,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// RFC 8628 §3.1 inherits token-endpoint client authentication: Basic works
/// at `/oauth/device_authorization` too.
#[tokio::test]
async fn device_authorization_with_basic_auth_issues_device_code() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/device_authorization",
        "scope=read".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert!(!body["device_code"]
        .as_str()
        .expect("device_code")
        .is_empty());
    assert!(!body["user_code"].as_str().expect("user_code").is_empty());
}

/// The device endpoint answers a failed Basic attempt exactly like the token
/// endpoint: 401 with a `WWW-Authenticate: Basic` challenge.
#[tokio::test]
async fn device_authorization_wrong_basic_secret_returns_401_with_basic_challenge() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/device_authorization",
        "scope=read".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, "not-the-secret"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        res.headers()
            .get("www-authenticate")
            .map(|v| v.to_str().unwrap()),
        Some(r#"Basic realm="gatekeeper""#)
    );
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_client",
            "error_description": "Invalid client_secret",
        })
    );
}
