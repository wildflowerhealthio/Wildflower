//! `browser_sessions` queries — the browsers the server has signed in
//! ([`BrowserSession`]), keyed by the `sid` the tokens, codes and refresh
//! families minted under each record.

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use crate::db::refresh_tokens::refresh_token_families;
use crate::db::shared::text_enum_column;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, BrowserSessionKind};

diesel::table! {
    browser_sessions (sid) {
        sid -> Text,
        kind -> Text,
        name -> Nullable<Text>,
        scopes -> Text,
        created_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        revoked_at -> Nullable<TimestamptzSqlite>,
        last_seen_at -> TimestamptzSqlite,
    }
}

diesel::allow_tables_to_appear_in_same_query!(browser_sessions, refresh_token_families);

// The session `kind` discriminant, stored as its strum wire string. Only the
// browser session binds it, so its mapping lives here.
text_enum_column!(BrowserSessionKind);

/// Persist a freshly started browser session.
pub(super) fn insert_browser_session(
    conn: &mut SqliteConnection,
    session: &BrowserSession,
) -> Result<(), AuthorizationServerError> {
    diesel::insert_into(browser_sessions::table)
        .values(session.clone())
        .execute(conn)
        .map_err(|e| {
            AuthorizationServerError::infrastructure("insert_browser_session failed", e)
        })?;
    Ok(())
}

/// Load the browser session `sid`, or `None` when no session has it.
pub(super) fn browser_session_by_sid(
    conn: &mut SqliteConnection,
    sid: &str,
) -> Result<Option<BrowserSession>, AuthorizationServerError> {
    browser_sessions::table
        .find(sid)
        .select(BrowserSession::as_select())
        .first(conn)
        .optional()
        .map_err(|e| AuthorizationServerError::infrastructure("browser_session_by_sid failed", e))
}

/// Stamp the browser session `sid` revoked at `now`, returning `true` iff a
/// standing session was transitioned. The `revoked_at IS NULL` guard keeps the
/// first revocation's instant.
pub(super) fn revoke_browser_session(
    conn: &mut SqliteConnection,
    sid: &str,
    now: DateTime<Utc>,
) -> Result<bool, AuthorizationServerError> {
    let affected = diesel::update(
        browser_sessions::table
            .find(sid)
            .filter(browser_sessions::revoked_at.is_null()),
    )
    .set(browser_sessions::revoked_at.eq(now))
    .execute(conn)
    .map_err(|e| AuthorizationServerError::infrastructure("revoke_browser_session failed", e))?;
    Ok(affected == 1)
}

/// Delete every browser session that expired or was revoked before `cutoff`
/// and that no refresh-token family alive at `cutoff` names, returning how
/// many went. A family that outlives its session's expiry keeps the row, so
/// its refresh still finds the session it was minted under.
pub(super) fn delete_browser_sessions_ended_before(
    conn: &mut SqliteConnection,
    cutoff: DateTime<Utc>,
) -> Result<usize, AuthorizationServerError> {
    let named_by_a_family_alive_at_cutoff = refresh_token_families::table
        .filter(refresh_token_families::expires_at.ge(cutoff))
        .filter(refresh_token_families::sid.is_not_null())
        .select(refresh_token_families::sid.assume_not_null());
    diesel::delete(
        browser_sessions::table
            .filter(
                browser_sessions::expires_at
                    .lt(cutoff)
                    .or(browser_sessions::revoked_at.lt(cutoff)),
            )
            .filter(browser_sessions::sid.ne_all(named_by_a_family_alive_at_cutoff)),
    )
    .execute(conn)
    .map_err(|e| {
        AuthorizationServerError::infrastructure("delete_browser_sessions_ended_before failed", e)
    })
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use crate::db::SqliteGrantStore;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::refresh_token::RefreshTokenFamily;
    use crate::domain::{GrantStore as _, GrantTx as _};

    fn store() -> SqliteGrantStore {
        SqliteGrantStore::open_in_memory().expect("store")
    }

    fn family(
        family_id: &str,
        sid: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> RefreshTokenFamily {
        RefreshTokenFamily {
            family_id: family_id.to_owned(),
            client_id: "app".to_owned(),
            scopes: vec!["offline_access".to_owned()],
            patient: None,
            issued_at: expires_at - Duration::days(90),
            expires_at,
            authorization_code_hash: None,
            grant_id: None,
            sid: Some(sid.to_owned()),
        }
    }

    /// A started session round-trips through the table, and revoking it stamps
    /// it once: a second revoke keeps the first instant and reports `false`.
    #[test]
    fn a_session_round_trips_and_is_revoked_once() {
        let store = store();
        let now = chrono::Utc::now();
        let session = BrowserSession::new_owner(
            vec!["system/*.cruds".to_owned(), "wildflower/*.cruds".to_owned()],
            Duration::hours(8),
            now,
        );
        store
            .with_connection(|tx| tx.insert_browser_session(&session))
            .expect("insert");
        assert_eq!(
            store.browser_session_by_sid(&session.sid).expect("read"),
            Some(session.clone())
        );
        assert!(store
            .browser_session_by_sid("no-such-sid")
            .expect("read")
            .is_none());

        let revoked_at = now + Duration::minutes(1);
        assert!(store
            .revoke_browser_session(&session.sid, revoked_at)
            .expect("revoke"));
        assert!(!store
            .revoke_browser_session(&session.sid, revoked_at + Duration::minutes(1))
            .expect("second revoke"));
        let stored = store
            .browser_session_by_sid(&session.sid)
            .expect("read")
            .expect("still there");
        assert_eq!(stored.revoked_at, Some(revoked_at));
        assert!(!store
            .revoke_browser_session("no-such-sid", now)
            .expect("revoke"));
    }

    /// The prune takes a session that expired or was revoked before the
    /// cutoff, unless a family alive at the cutoff names it; a session
    /// that ended after the cutoff stays.
    #[test]
    fn the_prune_takes_only_sessions_ended_before_the_cutoff_that_no_live_family_names() {
        let store = store();
        let now = chrono::Utc::now();
        let cutoff = now - Duration::hours(24);
        let session =
            |created_at| BrowserSession::new_owner(vec![], Duration::hours(8), created_at);
        let expired_long_ago = session(now - Duration::days(3));
        // Still unexpired, but revoked a day and more ago.
        let revoked_long_ago =
            BrowserSession::new_owner(vec![], Duration::hours(48), now - Duration::hours(30));
        let expired_recently = session(now - Duration::hours(10));
        let named_by_a_live_family = session(now - Duration::days(3));
        let named_by_a_dead_family = session(now - Duration::days(3));
        for session in [
            &expired_long_ago,
            &revoked_long_ago,
            &expired_recently,
            &named_by_a_live_family,
            &named_by_a_dead_family,
        ] {
            store
                .with_connection(|tx| tx.insert_browser_session(session))
                .expect("insert");
        }
        store
            .with_connection(|tx| {
                tx.revoke_browser_session(&revoked_long_ago.sid, now - Duration::hours(29))
            })
            .expect("revoke");
        store
            .with_connection(|tx| {
                tx.insert_refresh_token_family_row(&family(
                    "live",
                    &named_by_a_live_family.sid,
                    now + Duration::days(30),
                ))?;
                tx.insert_refresh_token_family_row(&family(
                    "dead",
                    &named_by_a_dead_family.sid,
                    now - Duration::days(2),
                ))
            })
            .expect("families");

        let pruned = store
            .with_connection(|tx| tx.delete_browser_sessions_ended_before(cutoff))
            .expect("prune");

        assert_eq!(pruned, 3);
        for (session, kept) in [
            (&expired_long_ago, false),
            (&revoked_long_ago, false),
            (&expired_recently, true),
            (&named_by_a_live_family, true),
            (&named_by_a_dead_family, false),
        ] {
            assert_eq!(
                store
                    .browser_session_by_sid(&session.sid)
                    .expect("read")
                    .is_some(),
                kept,
                "session created {}",
                session.created_at
            );
        }
    }
}
