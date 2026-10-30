//! Ending same-device sessions: the base ends a launch's Owner session by
//! the sign-in code it opened the launch with, through the server's current
//! run, once the server's launch views have closed, and a server start ends
//! every same-device session but those of the launch views still open, as
//! each is next used. An ended session is not revoked: its cookie stops
//! working at once, the browser is sent to pairing, and the next launch's
//! code signs it in again. Paired sessions survive a start.

use crate::common::*;

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

/// Whether `location`, relative to `/oauth/authorize`, is a consent card's.
fn is_consent_card(location: &str) -> bool {
    location.starts_with("authorize/") && location.ends_with("/consent")
}

/// Whether `location`, relative to `/oauth/authorize`, is the pairing
/// page's: where a browser without a live session is sent.
fn is_pairing_page(location: &str) -> bool {
    location.starts_with("pair?")
}

/// The browser session `sid` as `db` holds it.
fn stored_session(db: &TestDb, sid: &str) -> BrowserSession {
    store_handle(db)
        .read(|tx| tx.browser_session_by_sid(sid))
        .expect("read")
        .expect("stored")
}

/// Ending a launch's code ends exactly the session it signed in: that
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
    let closed_codes = [closed_code];

    assert_eq!(
        g.same_device_sign_in_code_minter
            .end_signed_in_sessions(&closed_codes)
            .expect("end"),
        1
    );
    assert_eq!(
        g.same_device_sign_in_code_minter
            .end_signed_in_sessions(&closed_codes)
            .expect("end again"),
        0,
        "ended already"
    );

    let closed_session = stored_session(&db, &sid_of(&closed_token));
    assert!(closed_session.expires_at <= Utc::now(), "expired");
    assert_eq!(closed_session.revoked_at, None, "not revoked");
    assert!(is_pairing_page(
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

/// A code whose view closed before it signed anyone in ends nothing, and is
/// withdrawn: presenting it afterwards signs nobody in.
#[tokio::test]
async fn a_code_that_signed_nobody_in_ends_nothing_and_is_withdrawn() {
    let (g, _owner_token, _db) = spin_up();
    let code = g.same_device_sign_in_code_minter.mint();
    assert_eq!(
        g.same_device_sign_in_code_minter
            .end_signed_in_sessions(std::slice::from_ref(&code))
            .expect("end"),
        0
    );
    let res = sign_in(&g, code.as_str(), "/").await;
    assert!(res.headers().get(axum::http::header::SET_COOKIE).is_none());
}

/// After a launch's session ends, the next launch signs the browser in again
/// and reaches the consent card.
#[tokio::test]
async fn a_second_launch_reaches_consent() {
    let (g, _owner_token, _db) = spin_up();
    let (first_code, _first_token) = launch(&g).await;
    assert_eq!(
        g.same_device_sign_in_code_minter
            .end_signed_in_sessions(&[first_code])
            .expect("end"),
        1
    );

    let (_second_code, second_token) = launch(&g).await;
    assert!(is_consent_card(
        &authorize_destination(&g, &second_token).await
    ));
}

/// A server start ends every same-device session an earlier run signed in,
/// so its cookie no longer reaches the consent card, but the session of a
/// launch view still open, while a paired session stands. The start writes
/// nothing: the ended session's row is left as it was. That view's
/// session is ended later through the new run, by the code the earlier run
/// minted. A launch on the new run signs the browser in again.
#[tokio::test]
async fn a_restart_ends_same_device_sessions_but_open_views_and_paired_ones() {
    let (g, _owner_token, db) = spin_up();
    let (_closed_code, closed_token) = launch(&g).await;
    let (open_code, open_token) = launch(&g).await;
    assert!(is_consent_card(
        &authorize_destination(&g, &closed_token).await
    ));

    let restarted = restart(&db, std::slice::from_ref(&open_code));

    assert!(
        stored_session(&db, &sid_of(&closed_token)).is_live(Utc::now()),
        "left as it was"
    );
    assert!(is_pairing_page(
        &authorize_destination(&restarted, &closed_token).await
    ));
    assert!(is_consent_card(
        &authorize_destination(&restarted, &open_token).await
    ));
    assert!(stored_session(&db, &db.paired_browser_sid).is_live(Utc::now()));
    assert!(restarted
        .in_process_token_verifier
        .verify(&db.paired_browser_token)
        .is_ok());

    assert_eq!(
        restarted
            .same_device_sign_in_code_minter
            .end_signed_in_sessions(&[open_code])
            .expect("end"),
        1
    );
    assert!(is_pairing_page(
        &authorize_destination(&restarted, &open_token).await
    ));

    let (_code, signed_in_again) = launch(&restarted).await;
    assert!(is_consent_card(
        &authorize_destination(&restarted, &signed_in_again).await
    ));
}
