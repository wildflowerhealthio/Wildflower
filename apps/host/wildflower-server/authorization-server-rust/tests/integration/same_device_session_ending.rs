//! Ending same-device sessions: the base ends a launch's Owner session by
//! the sign-in code it opened the launch with, when the launch's view closes,
//! and a server start ends every same-device session. An ended session is
//! expired, not revoked: its cookie stops working at once, the browser is sent
//! to pairing, and the next launch's code signs it in again. Paired sessions
//! survive a start.

use crate::common::*;
use wildflowerhealthio_authorization_server::SameDeviceSignInCode;

/// The `sid` claim of `token`, unverified.
fn sid_of(token: &str) -> String {
    decode_jwt_payload(token)["sid"]
        .as_str()
        .expect("the token names its browser session")
        .to_owned()
}

/// Sign a browser in as the Owner with a fresh code, as a launch does,
/// returning the code and the session token its cookie holds.
async fn launch(g: &AuthorizationServer) -> (SameDeviceSignInCode, String) {
    let code = g.same_device_sign_in_code_minter.mint();
    let session_token = browser_session_token(&sign_in(g, code.as_str(), "/").await);
    (code, session_token)
}

/// Where `/oauth/authorize` sends a browser holding `session_token`, for an
/// app the browser's session may approve.
async fn authorize_destination(g: &AuthorizationServer, session_token: &str) -> String {
    let res = get_authorize(
        &g.router,
        session_token,
        &authorize_query("brand-new-app", "read"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    location_of(&res)
}

/// Whether `location` is a consent card's.
fn is_consent_card(location: &str) -> bool {
    location.starts_with("authorize/") && location.ends_with("/consent")
}

/// The browser session `sid` as `db` holds it.
fn stored_session(db: &TestDb, sid: &str) -> BrowserSession {
    store_handle(db)
        .read(|tx| tx.browser_session_by_sid(sid))
        .expect("read")
        .expect("stored")
}

/// Closing a launch ends exactly the session its code signed in: that
/// session is expired, not revoked, its cookie no longer reaches the consent
/// card, and its token no longer passes the bearer gate. Another launch's
/// session stands, and ending by the same code again ends nothing.
#[tokio::test]
async fn closing_a_launch_ends_only_its_session() {
    let (g, _owner_token, db) = spin_up();
    let (closed_code, closed_token) = launch(&g).await;
    let (_open_code, open_token) = launch(&g).await;
    assert!(is_consent_card(
        &authorize_destination(&g, &closed_token).await
    ));

    assert!(closed_code.end_signed_in_session().expect("end"));
    assert!(
        !closed_code.end_signed_in_session().expect("end again"),
        "ended already"
    );

    let closed_session = stored_session(&db, &sid_of(&closed_token));
    assert!(closed_session.expires_at <= Utc::now(), "expired");
    assert_eq!(closed_session.revoked_at, None, "not revoked");
    assert!(!is_consent_card(
        &authorize_destination(&g, &closed_token).await
    ));
    assert_eq!(
        g.router
            .clone()
            .oneshot(owner_grants_probe(&closed_token))
            .await
            .expect("oneshot")
            .status(),
        StatusCode::UNAUTHORIZED
    );

    assert!(stored_session(&db, &sid_of(&open_token)).is_live(Utc::now()));
    assert!(is_consent_card(
        &authorize_destination(&g, &open_token).await
    ));
}

/// A code whose view closed before it signed anyone in ends nothing.
#[tokio::test]
async fn a_code_that_signed_nobody_in_ends_nothing() {
    let (g, _owner_token, _db) = spin_up();
    let code = g.same_device_sign_in_code_minter.mint();
    assert!(!code.end_signed_in_session().expect("end"));
}

/// After a launch's session ends, the next launch signs the browser in again
/// and reaches the consent card.
#[tokio::test]
async fn a_second_launch_reaches_consent() {
    let (g, _owner_token, _db) = spin_up();
    let (first_code, _first_token) = launch(&g).await;
    assert!(first_code.end_signed_in_session().expect("end"));

    let (_second_code, second_token) = launch(&g).await;
    assert!(is_consent_card(
        &authorize_destination(&g, &second_token).await
    ));
}

/// A server start expires every same-device session an earlier run signed
/// in, so its cookie no longer reaches the consent card, while a paired
/// session stands. A launch on the new run signs the browser in again.
#[tokio::test]
async fn a_restart_ends_same_device_sessions_but_not_paired_ones() {
    let (g, _owner_token, db) = spin_up();
    let (_code, same_device_token) = launch(&g).await;

    let restarted = restart(&db);

    let same_device_session = stored_session(&db, &sid_of(&same_device_token));
    assert!(same_device_session.expires_at <= Utc::now(), "expired");
    assert_eq!(same_device_session.revoked_at, None, "not revoked");
    assert!(!is_consent_card(
        &authorize_destination(&restarted, &same_device_token).await
    ));
    assert!(stored_session(&db, &db.paired_browser_sid).is_live(Utc::now()));
    assert!(g
        .in_process_token_verifier
        .verify(&db.paired_browser_token)
        .is_ok());

    let (_code, signed_in_again) = launch(&restarted).await;
    assert!(is_consent_card(
        &authorize_destination(&restarted, &signed_in_again).await
    ));
}
