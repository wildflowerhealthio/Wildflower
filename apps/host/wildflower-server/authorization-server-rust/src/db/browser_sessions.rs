//! `browser_sessions` queries — the browsers the server has signed in
//! ([`BrowserSession`]), keyed by the `sid` the tokens, codes and refresh
//! families minted under each record.

use chrono::{DateTime, Utc};
use diesel::dsl::{exists, not};
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

/// Whether the browser session `sid` is revoked or missing: no row with that
/// `sid` and `revoked_at IS NULL` exists.
pub(super) fn browser_session_is_revoked(
    conn: &mut SqliteConnection,
    sid: &str,
) -> Result<bool, AuthorizationServerError> {
    diesel::select(not(exists(
        browser_sessions::table
            .find(sid)
            .filter(browser_sessions::revoked_at.is_null()),
    )))
    .get_result(conn)
    .map_err(|e| AuthorizationServerError::infrastructure("browser_session_is_revoked failed", e))
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

/// Move the browser session `sid`'s `last_seen_at` to `seen_at`, unless it was
/// last seen after `seen_before`, returning `true` iff it moved. The
/// guard keeps the column from moving backwards, and from moving more than
/// once inside a window that ends at `seen_at`.
pub(super) fn touch_browser_session_last_seen(
    conn: &mut SqliteConnection,
    sid: &str,
    seen_at: DateTime<Utc>,
    seen_before: DateTime<Utc>,
) -> Result<bool, AuthorizationServerError> {
    let affected = diesel::update(
        browser_sessions::table
            .find(sid)
            .filter(browser_sessions::last_seen_at.le(seen_before)),
    )
    .set(browser_sessions::last_seen_at.eq(seen_at))
    .execute(conn)
    .map_err(|e| {
        AuthorizationServerError::infrastructure("touch_browser_session_last_seen failed", e)
    })?;
    Ok(affected == 1)
}

/// Delete every browser session that expired or was revoked before `cutoff`
/// and that no refresh-token family alive at `cutoff` names, returning how
/// many went. A family that outlives its session's expiry keeps the row, so
/// its refresh still finds the session it was minted under. The family probe
/// is correlated on `sid`, so `refresh_token_families_sid_idx` answers it.
pub(super) fn delete_browser_sessions_ended_before(
    conn: &mut SqliteConnection,
    cutoff: DateTime<Utc>,
) -> Result<usize, AuthorizationServerError> {
    let named_by_a_family_alive_at_cutoff = exists(
        refresh_token_families::table
            .filter(refresh_token_families::sid.eq(browser_sessions::sid.nullable()))
            .filter(refresh_token_families::expires_at.ge(cutoff)),
    );
    diesel::delete(
        browser_sessions::table
            .filter(
                browser_sessions::expires_at
                    .lt(cutoff)
                    .or(browser_sessions::revoked_at.lt(cutoff)),
            )
            .filter(not(named_by_a_family_alive_at_cutoff)),
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
    /// It reads as revoked once revoked, and so does a `sid` with no row.
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
        assert!(!store
            .browser_session_is_revoked(&session.sid)
            .expect("read"));
        assert!(store
            .browser_session_is_revoked("no-such-sid")
            .expect("read"));

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
        assert!(store
            .browser_session_is_revoked(&session.sid)
            .expect("read"));
        assert!(!store
            .revoke_browser_session("no-such-sid", now)
            .expect("revoke"));
    }

    /// A touch moves `last_seen_at` only when it was last seen before the
    /// guard, so a second touch inside the window and a touch from the past
    /// leave it; a `sid` with no row moves nothing.
    #[test]
    fn a_touch_moves_last_seen_only_past_the_guard() {
        let store = store();
        let signed_in_at = chrono::Utc::now();
        let session = BrowserSession::new_owner(vec![], Duration::hours(8), signed_in_at);
        store
            .with_connection(|tx| tx.insert_browser_session(&session))
            .expect("insert");
        let last_seen = |store: &SqliteGrantStore| {
            store
                .browser_session_by_sid(&session.sid)
                .expect("read")
                .expect("stored")
                .last_seen_at
        };

        let seen_at = signed_in_at + Duration::minutes(6);
        assert!(store
            .touch_browser_session_last_seen(&session.sid, seen_at, seen_at - Duration::minutes(5))
            .expect("touch"));
        assert_eq!(last_seen(&store), seen_at);

        let soon_after = seen_at + Duration::minutes(1);
        assert!(!store
            .touch_browser_session_last_seen(
                &session.sid,
                soon_after,
                soon_after - Duration::minutes(5)
            )
            .expect("touch inside the window"));
        assert!(!store
            .touch_browser_session_last_seen(&session.sid, signed_in_at, signed_in_at)
            .expect("touch from the past"));
        assert_eq!(last_seen(&store), seen_at);
        assert!(!store
            .touch_browser_session_last_seen("no-such-sid", soon_after, soon_after)
            .expect("touch"));
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
