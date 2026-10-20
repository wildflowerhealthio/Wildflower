//! `POST /oauth/revoke` (RFC 7009) and refresh redemption against the client's
//! revocation epoch: an app revokes its own refresh or access token, a token
//! that isn't the client's own is answered `200` and left alone, and bumping
//! the client's epoch stops its refresh families.

use crate::common::*;

/// The public client the tests revoke as.
const APP_CLIENT_ID: &str = "revoking-app";

/// A second public client, whose tokens [`APP_CLIENT_ID`] must not revoke.
const OTHER_CLIENT_ID: &str = "other-app";

/// Register both test clients as public clients allowed `read` and
/// `offline_access` at `https://app.example/cb`.
fn seed_public_clients(db: &TestDb) {
    for client_id in [APP_CLIENT_ID, OTHER_CLIENT_ID] {
        seed_client_with_redirect(
            db,
            client_id,
            "https://app.example/cb",
            &["read", "offline_access"],
        );
    }
}

/// POST `body` as a form to `path`.
async fn post_form_body(
    router: &axum::Router,
    path: &str,
    body: String,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(build_request(
            Request::post(path).header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body),
        ))
        .await
        .expect("oneshot")
}

/// Revoke `token` as the public client `client_id`.
async fn revoke(g: &AuthorizationServer, client_id: &str, token: &str) -> axum::response::Response {
    post_form_body(
        &g.router,
        "/oauth/revoke",
        format!("client_id={client_id}&token={token}"),
    )
    .await
}

/// Redeem `refresh_token` as the public client `client_id`.
async fn refresh(
    g: &AuthorizationServer,
    client_id: &str,
    refresh_token: &str,
) -> axum::response::Response {
    post_form_body(
        &g.router,
        "/oauth/token",
        format!("grant_type=refresh_token&client_id={client_id}&refresh_token={refresh_token}"),
    )
    .await
}

/// A `200` with an empty body, the RFC 7009 §2.2 success answer.
async fn assert_revocation_answered(res: axum::response::Response, what: &str) {
    assert_eq!(res.status(), StatusCode::OK, "{what}");
    assert_eq!(body_string(res.into_body()).await, "", "{what}");
}

/// The `invalid_grant` refusal a revoked family's token gets at `/oauth/token`.
async fn assert_refresh_revoked(res: axum::response::Response) {
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(res.into_body()).await["error"], "invalid_grant");
}

/// An app revokes its own refresh token: the whole family ends, so neither
/// that token nor its successor refreshes again.
#[tokio::test]
async fn an_app_revokes_its_own_refresh_token() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    plant_refresh_token(
        &store_handle(&db),
        "app-refresh",
        APP_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    let res = refresh(&g, APP_CLIENT_ID, "app-refresh").await;
    assert_eq!(res.status(), StatusCode::OK);
    let successor = body_json(res.into_body()).await["refresh_token"]
        .as_str()
        .expect("a successor")
        .to_owned();

    assert_revocation_answered(
        revoke(&g, APP_CLIENT_ID, &successor).await,
        "revoking the app's own refresh token",
    )
    .await;

    assert_refresh_revoked(refresh(&g, APP_CLIENT_ID, &successor).await).await;
}

/// An app revokes its own access token: its `jti` is denylisted, so the token
/// no longer authenticates anywhere.
#[tokio::test]
async fn an_app_revokes_its_own_access_token() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    let access_token = mint_client_token(&db, APP_CLIENT_ID, &["openid"]);
    let gate_status = |token: String| {
        let router = g.router.clone();
        async move {
            router
                .oneshot(owner_grants_probe(&token))
                .await
                .expect("oneshot")
                .status()
        }
    };
    assert_eq!(
        gate_status(access_token.clone()).await,
        StatusCode::FORBIDDEN,
        "live, though it reaches no /authorization scope"
    );

    assert_revocation_answered(
        revoke(&g, APP_CLIENT_ID, &access_token).await,
        "revoking the app's own access token",
    )
    .await;

    assert!(revocation_store_handle(&db)
        .is_revoked_by_jti(&jti_of(&access_token))
        .expect("query"));
    assert_eq!(
        gate_status(access_token).await,
        StatusCode::UNAUTHORIZED,
        "the revoked token no longer authenticates"
    );
}

/// Another client's tokens get the same `200` as the app's own, and are left
/// alone: the other client still refreshes, and its access token is not
/// denylisted.
#[tokio::test]
async fn another_client_s_tokens_are_answered_alike_and_left_alone() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    plant_refresh_token(
        &store_handle(&db),
        "other-refresh",
        OTHER_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    let other_access_token = mint_client_token(&db, OTHER_CLIENT_ID, &["openid"]);

    assert_revocation_answered(
        revoke(&g, APP_CLIENT_ID, "other-refresh").await,
        "another client's refresh token",
    )
    .await;
    assert_revocation_answered(
        revoke(&g, APP_CLIENT_ID, &other_access_token).await,
        "another client's access token",
    )
    .await;

    assert_eq!(
        refresh(&g, OTHER_CLIENT_ID, "other-refresh").await.status(),
        StatusCode::OK,
        "the other client's family lives on"
    );
    assert!(!revocation_store_handle(&db)
        .is_revoked_by_jti(&jti_of(&other_access_token))
        .expect("query"));
}

/// A token the server never issued, an already-revoked one, and an access
/// token minted for another server all get `200` (RFC 7009 §2.2).
#[tokio::test]
async fn unknown_and_dead_tokens_get_200() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    assert_revocation_answered(
        revoke(&g, APP_CLIENT_ID, "never-issued").await,
        "an unknown token",
    )
    .await;

    plant_refresh_token(
        &store_handle(&db),
        "expired-refresh",
        APP_CLIENT_ID,
        Utc::now() - Duration::minutes(1),
    );
    assert_revocation_answered(
        revoke(&g, APP_CLIENT_ID, "expired-refresh").await,
        "an expired refresh token",
    )
    .await;

    let foreign = mint_token_naming(
        &db,
        &["openid"],
        "https://elsewhere.example",
        "https://elsewhere.example",
    );
    assert_revocation_answered(
        revoke(&g, APP_CLIENT_ID, &foreign).await,
        "another server's access token",
    )
    .await;
}

/// A `client_id` with no registration is `401 invalid_client`, and the token
/// it presented is left alone.
#[tokio::test]
async fn an_unknown_client_is_invalid_client() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    plant_refresh_token(
        &store_handle(&db),
        "app-refresh",
        APP_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    let res = revoke(&g, "no-such-client", "app-refresh").await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body_json(res.into_body()).await["error"], "invalid_client");
    assert_eq!(
        refresh(&g, APP_CLIENT_ID, "app-refresh").await.status(),
        StatusCode::OK
    );
}

/// A confidential client authenticates with its secret, as at `/oauth/token`:
/// a wrong Basic secret is `401 invalid_client` with a Basic challenge; the
/// right one revokes.
#[tokio::test]
async fn a_confidential_client_revokes_with_its_secret() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/revoke",
        "token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, "not-the-secret"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        res.headers()
            .get("www-authenticate")
            .map(|v| v.to_str().unwrap()),
        Some(r#"Basic realm="wildflower-authorization""#)
    );
    assert_eq!(body_json(res.into_body()).await["error"], "invalid_client");

    let res = post_form_with_authorization(
        &g.router,
        "/oauth/revoke",
        "token=conf-token&token_type_hint=refresh_token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_revocation_answered(res, "the confidential client's refresh token").await;
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_refresh_revoked(res).await;
}

/// The hint is not needed to find the token: a refresh token hinted as an
/// access token is still revoked.
#[tokio::test]
async fn a_wrong_token_type_hint_still_revokes() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    plant_refresh_token(
        &store_handle(&db),
        "app-refresh",
        APP_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    let res = post_form_body(
        &g.router,
        "/oauth/revoke",
        format!("client_id={APP_CLIENT_ID}&token=app-refresh&token_type_hint=access_token"),
    )
    .await;
    assert_revocation_answered(res, "a mis-hinted refresh token").await;
    assert_refresh_revoked(refresh(&g, APP_CLIENT_ID, "app-refresh").await).await;
}

/// A request without a `token`, or not form-encoded, is `400 invalid_request`.
#[tokio::test]
async fn a_malformed_request_is_invalid_request() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    let res = post_form_body(
        &g.router,
        "/oauth/revoke",
        format!("client_id={APP_CLIENT_ID}"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(res.into_body()).await["error"], "invalid_request");

    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::post("/oauth/revoke").header("content-type", "application/json"),
            Body::from(format!(r#"{{"client_id":"{APP_CLIENT_ID}","token":"t"}}"#)),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(res.into_body()).await["error"], "invalid_request");
}

/// Bumping the client's revocation epoch (here the Owner's subject revoke)
/// stops every refresh family it held: the next refresh is `invalid_grant`.
#[tokio::test]
async fn bumping_the_client_s_epoch_stops_refresh() {
    let (g, owner_token, db) = spin_up();
    seed_public_clients(&db);
    plant_refresh_token(
        &store_handle(&db),
        "app-refresh",
        APP_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    plant_refresh_token(
        &store_handle(&db),
        "other-refresh",
        OTHER_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );

    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &owner_token,
            serde_json::json!({ "subject": APP_CLIENT_ID }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let res = refresh(&g, APP_CLIENT_ID, "app-refresh").await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has been revoked",
        })
    );
    assert_eq!(
        refresh(&g, OTHER_CLIENT_ID, "other-refresh").await.status(),
        StatusCode::OK,
        "another client's epoch is its own"
    );
}

/// A family that began after the client's epoch refreshes as usual.
#[tokio::test]
async fn a_family_begun_after_the_epoch_refreshes() {
    let (g, _owner_token, db) = spin_up();
    seed_public_clients(&db);
    revocation_store_handle(&db)
        .bump_subject_epoch(APP_CLIENT_ID, Utc::now() - Duration::hours(1))
        .expect("bump");
    plant_refresh_token(
        &store_handle(&db),
        "app-refresh",
        APP_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    assert_eq!(
        refresh(&g, APP_CLIENT_ID, "app-refresh").await.status(),
        StatusCode::OK
    );
}
