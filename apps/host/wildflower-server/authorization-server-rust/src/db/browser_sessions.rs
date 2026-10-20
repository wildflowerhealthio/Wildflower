//! `browser_sessions` — the browsers the server has signed in
//! ([`BrowserSession`]), keyed by the `sid` the tokens, codes and refresh
//! families minted under each record — and the apps each session has gone on
//! past its limited page for (`session_shortfall_acknowledgements`): the
//! [`BrowserSessionsTx`] primitives on [`SqliteGrantTx`].

use chrono::{DateTime, Utc};
use diesel::dsl::{exists, not};
use diesel::prelude::*;

use crate::db::grant_store::SqliteGrantTx;
use crate::db::refresh_tokens::refresh_token_families;
use crate::db::shared::text_enum_column;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, BrowserSessionKind};
use crate::domain::grant_store::BrowserSessionsTx;

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

diesel::table! {
    session_shortfall_acknowledgements (sid, client_id) {
        sid -> Text,
        client_id -> Text,
    }
}

diesel::allow_tables_to_appear_in_same_query!(browser_sessions, refresh_token_families);
diesel::allow_tables_to_appear_in_same_query!(browser_sessions, session_shortfall_acknowledgements);

// The session `kind` discriminant, stored as its strum wire string. Only the
// browser session binds it, so its mapping lives here.
text_enum_column!(BrowserSessionKind);

impl BrowserSessionsTx for SqliteGrantTx<'_> {
    /// Persist a freshly started browser session.
    fn insert_browser_session(
        &mut self,
        session: &BrowserSession,
    ) -> Result<(), AuthorizationServerError> {
        let conn = &mut *self.conn;
        diesel::insert_into(browser_sessions::table)
            .values(session.clone())
            .execute(conn)
            .map_err(|e| {
                AuthorizationServerError::infrastructure("insert_browser_session failed", e)
            })?;
        Ok(())
    }

    /// Load the browser session `sid`, or `None` when no session has it.
    fn browser_session_by_sid(
        &mut self,
        sid: &str,
    ) -> Result<Option<BrowserSession>, AuthorizationServerError> {
        let conn = &mut *self.conn;
        browser_sessions::table
            .find(sid)
            .select(BrowserSession::as_select())
            .first(conn)
            .optional()
            .map_err(|e| {
                AuthorizationServerError::infrastructure("browser_session_by_sid failed", e)
            })
    }

    /// Every browser session live at `now` (not revoked, `expires_at` after
    /// `now`), newest first.
    fn live_browser_sessions(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Vec<BrowserSession>, AuthorizationServerError> {
        let conn = &mut *self.conn;
        browser_sessions::table
            .filter(browser_sessions::revoked_at.is_null())
            .filter(browser_sessions::expires_at.gt(now))
            .order(browser_sessions::created_at.desc())
            .select(BrowserSession::as_select())
            .load(conn)
            .map_err(|e| {
                AuthorizationServerError::infrastructure("live_browser_sessions failed", e)
            })
    }

    /// Whether the browser session `sid` is revoked or missing: no row with that
    /// `sid` and `revoked_at IS NULL` exists.
    fn is_browser_session_revoked(&mut self, sid: &str) -> Result<bool, AuthorizationServerError> {
        let conn = &mut *self.conn;
        diesel::select(not(exists(
            browser_sessions::table
                .find(sid)
                .filter(browser_sessions::revoked_at.is_null()),
        )))
        .get_result(conn)
        .map_err(|e| {
            AuthorizationServerError::infrastructure("is_browser_session_revoked failed", e)
        })
    }

    /// Stamp the browser session `sid` revoked at `now`, returning `true` iff a
    /// standing session was transitioned. The `revoked_at IS NULL` guard keeps the
    /// first revocation's instant.
    fn revoke_browser_session(
        &mut self,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let conn = &mut *self.conn;
        let affected = diesel::update(
            browser_sessions::table
                .find(sid)
                .filter(browser_sessions::revoked_at.is_null()),
        )
        .set(browser_sessions::revoked_at.eq(now))
        .execute(conn)
        .map_err(|e| {
            AuthorizationServerError::infrastructure("revoke_browser_session failed", e)
        })?;
        Ok(affected == 1)
    }

    /// Move the browser session `sid`'s `last_seen_at` to `seen_at`, unless it was
    /// last seen after `seen_before`, returning `true` iff it moved. The
    /// guard keeps the column from moving backwards, and from moving more than
    /// once inside a window that ends at `seen_at`. Moved by the cookie-use
    /// recorder and by a refresh-token rotation under the session.
    fn touch_browser_session_last_seen(
        &mut self,
        sid: &str,
        seen_at: DateTime<Utc>,
        seen_before: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let conn = &mut *self.conn;
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

    /// Whether the browser session `sid` has gone on past its limited page for
    /// `client_id` before.
    fn is_session_shortfall_acknowledged_for_client(
        &mut self,
        sid: &str,
        client_id: &str,
    ) -> Result<bool, AuthorizationServerError> {
        let conn = &mut *self.conn;
        diesel::select(exists(
            session_shortfall_acknowledgements::table.find((sid, client_id)),
        ))
        .get_result(conn)
        .map_err(|e| {
            AuthorizationServerError::infrastructure(
                "is_session_shortfall_acknowledged_for_client failed",
                e,
            )
        })
    }

    /// Record that the browser session `sid` went on past its limited page for
    /// `client_id`. Recording it again changes nothing.
    fn record_session_shortfall_acknowledgement(
        &mut self,
        sid: &str,
        client_id: &str,
    ) -> Result<(), AuthorizationServerError> {
        let conn = &mut *self.conn;
        diesel::insert_into(session_shortfall_acknowledgements::table)
            .values((
                session_shortfall_acknowledgements::sid.eq(sid),
                session_shortfall_acknowledgements::client_id.eq(client_id),
            ))
            .on_conflict_do_nothing()
            .execute(conn)
            .map_err(|e| {
                AuthorizationServerError::infrastructure(
                    "record_session_shortfall_acknowledgement failed",
                    e,
                )
            })?;
        Ok(())
    }

    /// Delete every browser session that expired or was revoked before `cutoff`
    /// and that no refresh-token family alive at `cutoff` names, returning how
    /// many went, and with them every limited-page acknowledgement whose session
    /// is gone. A family that outlives its session's expiry keeps the row, so
    /// its refresh still finds the session it was minted under. The family probe
    /// is correlated on `sid`, so `refresh_token_families_sid_idx` answers it.
    fn delete_browser_sessions_ended_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        let conn = &mut *self.conn;
        let named_by_a_family_alive_at_cutoff = exists(
            refresh_token_families::table
                .filter(refresh_token_families::sid.eq(browser_sessions::sid.nullable()))
                .filter(refresh_token_families::expires_at.ge(cutoff)),
        );
        let pruned = diesel::delete(
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
            AuthorizationServerError::infrastructure(
                "delete_browser_sessions_ended_before failed",
                e,
            )
        })?;
        diesel::delete(session_shortfall_acknowledgements::table.filter(
            not(exists(browser_sessions::table.filter(
                browser_sessions::sid.eq(session_shortfall_acknowledgements::sid),
            ))),
        ))
        .execute(conn)
        .map_err(|e| {
            AuthorizationServerError::infrastructure(
                "delete session_shortfall_acknowledgements without a session failed",
                e,
            )
        })?;
        Ok(pruned)
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use crate::db::SqliteGrantStore;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::refresh_token::RefreshTokenFamily;

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
            .write(|tx| tx.insert_browser_session(&session))
            .expect("insert");
        assert_eq!(
            store
                .read(|tx| tx.browser_session_by_sid(&session.sid))
                .expect("read"),
            Some(session.clone())
        );
        assert!(store
            .read(|tx| tx.browser_session_by_sid("no-such-sid"))
            .expect("read")
            .is_none());
        assert!(!store
            .read(|tx| tx.is_browser_session_revoked(&session.sid))
            .expect("read"));
        assert!(store
            .read(|tx| tx.is_browser_session_revoked("no-such-sid"))
            .expect("read"));

        let revoked_at = now + Duration::minutes(1);
        assert!(store
            .write(|tx| tx.revoke_browser_session(&session.sid, revoked_at))
            .expect("revoke"));
        assert!(!store
            .write(|tx| tx.revoke_browser_session(&session.sid, revoked_at + Duration::minutes(1)))
            .expect("second revoke"));
        let stored = store
            .read(|tx| tx.browser_session_by_sid(&session.sid))
            .expect("read")
            .expect("still there");
        assert_eq!(stored.revoked_at, Some(revoked_at));
        assert!(store
            .read(|tx| tx.is_browser_session_revoked(&session.sid))
            .expect("read"));
        assert!(!store
            .write(|tx| tx.revoke_browser_session("no-such-sid", now))
            .expect("revoke"));
    }

    /// Only sessions neither revoked nor expired at `now` are live, newest
    /// first.
    #[test]
    fn live_sessions_are_the_unrevoked_unexpired_ones_newest_first() {
        let store = store();
        let now = chrono::Utc::now();
        let older = BrowserSession::new_owner(vec![], Duration::hours(8), now - Duration::hours(2));
        let newer = BrowserSession::new_owner(vec![], Duration::hours(8), now - Duration::hours(1));
        let expired =
            BrowserSession::new_owner(vec![], Duration::hours(8), now - Duration::hours(9));
        let revoked = BrowserSession::new_owner(vec![], Duration::hours(8), now);
        for session in [&older, &newer, &expired, &revoked] {
            store
                .write(|tx| tx.insert_browser_session(session))
                .expect("insert");
        }
        store
            .write(|tx| tx.revoke_browser_session(&revoked.sid, now))
            .expect("revoke");

        let live: Vec<String> = store
            .read(|tx| tx.live_browser_sessions(now))
            .expect("read")
            .into_iter()
            .map(|session| session.sid)
            .collect();
        assert_eq!(live, vec![newer.sid, older.sid]);
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
            .write(|tx| tx.insert_browser_session(&session))
            .expect("insert");
        let last_seen = |store: &SqliteGrantStore| {
            store
                .read(|tx| tx.browser_session_by_sid(&session.sid))
                .expect("read")
                .expect("stored")
                .last_seen_at
        };

        let seen_at = signed_in_at + Duration::minutes(6);
        assert!(store
            .write(|tx| tx.touch_browser_session_last_seen(
                &session.sid,
                seen_at,
                seen_at - Duration::minutes(5)
            ))
            .expect("touch"));
        assert_eq!(last_seen(&store), seen_at);

        let soon_after = seen_at + Duration::minutes(1);
        assert!(!store
            .write(|tx| tx.touch_browser_session_last_seen(
                &session.sid,
                soon_after,
                soon_after - Duration::minutes(5)
            ))
            .expect("touch inside the window"));
        assert!(!store
            .write(|tx| tx.touch_browser_session_last_seen(
                &session.sid,
                signed_in_at,
                signed_in_at
            ))
            .expect("touch from the past"));
        assert_eq!(last_seen(&store), seen_at);
        assert!(!store
            .write(|tx| tx.touch_browser_session_last_seen("no-such-sid", soon_after, soon_after))
            .expect("touch"));
    }

    /// A session's limited-page acknowledgement is per client, and recording
    /// it twice is no error.
    #[test]
    fn a_session_shortfall_acknowledgement_is_per_session_and_client() {
        let store = store();
        assert!(!store
            .read(|tx| tx.is_session_shortfall_acknowledged_for_client("sid-1", "app"))
            .expect("read"));
        for _ in 0..2 {
            store
                .write(|tx| tx.record_session_shortfall_acknowledgement("sid-1", "app"))
                .expect("record");
        }
        for (sid, client_id, acknowledged) in [
            ("sid-1", "app", true),
            ("sid-1", "other-app", false),
            ("sid-2", "app", false),
        ] {
            assert_eq!(
                store
                    .read(|tx| tx.is_session_shortfall_acknowledged_for_client(sid, client_id))
                    .expect("read"),
                acknowledged,
                "{sid} {client_id}"
            );
        }
    }

    /// The prune takes a session that expired or was revoked before the
    /// cutoff, unless a family alive at the cutoff names it, and the
    /// limited-page acknowledgements of every session it takes; a session
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
                .write(|tx| tx.insert_browser_session(session))
                .expect("insert");
        }
        store
            .write(|tx| tx.revoke_browser_session(&revoked_long_ago.sid, now - Duration::hours(29)))
            .expect("revoke");
        store
            .write(|tx| {
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
        store
            .write(|tx| {
                tx.record_session_shortfall_acknowledgement(&expired_long_ago.sid, "app")?;
                tx.record_session_shortfall_acknowledgement(&expired_recently.sid, "app")
            })
            .expect("acknowledgements");

        let pruned = store
            .write(|tx| tx.delete_browser_sessions_ended_before(cutoff))
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
                    .read(|tx| tx.browser_session_by_sid(&session.sid))
                    .expect("read")
                    .is_some(),
                kept,
                "session created {}",
                session.created_at
            );
        }
        for (session, kept) in [(&expired_long_ago, false), (&expired_recently, true)] {
            assert_eq!(
                store
                    .read(|tx| tx.is_session_shortfall_acknowledged_for_client(&session.sid, "app"))
                    .expect("read"),
                kept,
                "acknowledgement of the session created {}",
                session.created_at
            );
        }
    }
}
