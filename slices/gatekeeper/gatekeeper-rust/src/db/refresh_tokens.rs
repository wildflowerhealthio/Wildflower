use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use crate::db_utils::sql_builder::build_insert_sql;
use crate::db_utils::{DbResult, GatekeeperStore};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};

fn family_named_sql_params(family: &RefreshTokenFamily) -> [(&str, &dyn ToSql); 7] {
    [
        (":family_id", &family.family_id),
        (":client_id", &family.client_id),
        (":scopes", &family.scopes),
        (":patient", &family.patient),
        (":issued_at", &family.issued_at),
        (":expires_at", &family.expires_at),
        (":authorization_code_hash", &family.authorization_code_hash),
    ]
}

fn token_named_sql_params(token: &RefreshToken) -> [(&str, &dyn ToSql); 4] {
    [
        (":token_hash", &token.token_hash),
        (":family_id", &token.family_id),
        (":issued_at", &token.issued_at),
        (":consumed_at", &token.consumed_at),
    ]
}

impl TryFrom<&Row<'_>> for RefreshToken {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(RefreshToken {
            token_hash: row.get("token_hash")?,
            family_id: row.get("family_id")?,
            issued_at: row.get("issued_at")?,
            consumed_at: row.get("consumed_at")?,
        })
    }
}

/// Outcome of attempting to consume a refresh token.
pub enum RefreshTokenConsumeOutcome {
    /// The token was live and is now consumed. The caller can proceed with
    /// issuing new credentials and a new refresh token.
    Consumed,
    /// The token was already consumed — this is a replay, and the caller must
    /// reject the request and revoke the whole family.
    Replayed,
    /// No such token exists. The caller should treat this as a failed decode
    /// rather than a replay, so no need to revoke the family.
    NotFound,
}

impl GatekeeperStore {
    /// Persist a new refresh-token family alongside its first token — one
    /// transaction, since a family with no token (or a token with no family)
    /// is unrepresentable on purpose.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, either insert,
    /// or the commit fails.
    pub fn insert_refresh_token_family(
        &self,
        family: &RefreshTokenFamily,
        first_token: &RefreshToken,
    ) -> DbResult<()> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        {
            let family_params = family_named_sql_params(family);
            tx.execute(
                &build_insert_sql("refresh_token_families", &family_params),
                &family_params,
            )?;
            let token_params = token_named_sql_params(first_token);
            tx.execute(
                &build_insert_sql("refresh_tokens", &token_params),
                &token_params,
            )?;
        }
        tx.commit()
    }

    /// Persist the successor token in an existing family's rotation.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the insert fails (for example a
    /// unique-constraint violation on the token hash).
    pub fn insert_refresh_token(&self, token: &RefreshToken) -> DbResult<()> {
        let params = token_named_sql_params(token);
        self.conn()
            .lock()
            .execute(&build_insert_sql("refresh_tokens", &params), &params)?;
        Ok(())
    }

    /// Resolve a presented token hash to its row plus the owning family in
    /// one JOIN. Consumed tokens resolve too — the caller distinguishes a
    /// live token from a replayed one via `consumed_at`.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the join query fails or a returned row
    /// cannot be mapped to a [`RefreshToken`]/[`RefreshTokenFamily`] pair.
    pub fn refresh_token_with_family_by_hash(
        &self,
        token_hash: &str,
    ) -> DbResult<Option<(RefreshToken, RefreshTokenFamily)>> {
        self.conn()
            .lock()
            .query_row(
                "SELECT t.token_hash, t.family_id, t.issued_at, t.consumed_at,
                        f.client_id, f.scopes, f.patient,
                        f.issued_at AS family_issued_at, f.expires_at,
                        f.authorization_code_hash
                 FROM refresh_tokens t
                 JOIN refresh_token_families f ON f.family_id = t.family_id
                 WHERE t.token_hash = ?1",
                params![token_hash],
                |row| {
                    let token = RefreshToken::try_from(row)?;
                    let family = RefreshTokenFamily {
                        family_id: row.get("family_id")?,
                        client_id: row.get("client_id")?,
                        scopes: row.get("scopes")?,
                        patient: row.get("patient")?,
                        issued_at: row.get("family_issued_at")?,
                        expires_at: row.get("expires_at")?,
                        authorization_code_hash: row.get("authorization_code_hash")?,
                    };
                    Ok((token, family))
                },
            )
            .optional()
    }

    /// Look up a single token by hash — enough for callers that don't need
    /// the family facts.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the select query fails or a returned row
    /// cannot be mapped to a [`RefreshToken`].
    pub fn refresh_token_by_hash(&self, token_hash: &str) -> DbResult<Option<RefreshToken>> {
        self.conn()
            .lock()
            .query_row(
                "SELECT token_hash, family_id, issued_at, consumed_at
                 FROM refresh_tokens WHERE token_hash = ?1",
                params![token_hash],
                |row| RefreshToken::try_from(row),
            )
            .optional()
    }

    /// Atomically consume a live refresh token, reporting which
    /// of the three [`RefreshTokenConsumeOutcome`] states the row was in. The
    /// UPDATE's `consumed_at IS NULL` guard and the fallback existence probe
    /// run in one transaction, so a concurrent redeemer of the same token
    /// sees `Replayed`, never a torn state.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, the update, the
    /// existence probe, or the commit fails.
    pub fn consume_refresh_token(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> DbResult<RefreshTokenConsumeOutcome> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        let affected = tx.execute(
            "UPDATE refresh_tokens SET consumed_at = ?2
             WHERE token_hash = ?1 AND consumed_at IS NULL",
            params![token_hash, now],
        )?;
        let result = if affected == 1 {
            RefreshTokenConsumeOutcome::Consumed
        } else {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM refresh_tokens WHERE token_hash = ?1)",
                params![token_hash],
                |row| row.get(0),
            )?;
            if exists {
                RefreshTokenConsumeOutcome::Replayed
            } else {
                RefreshTokenConsumeOutcome::NotFound
            }
        };
        tx.commit()?;
        Ok(result)
    }

    /// Atomically rotate a refresh token: consume the presented token and, only
    /// if that succeeded, insert its successor — both in one transaction.
    /// Doing the consume and the successor-insert together means a crash or
    /// error can't burn the presented token while leaving the family with no
    /// live successor (a permanent lockout). The three-state outcome mirrors
    /// [`Self::consume_refresh_token`]: `Consumed` means the successor is now
    /// the family's live token; `Replayed`/`NotFound` leave the family
    /// untouched (no successor inserted) for the caller to handle.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, the update, the
    /// existence probe, the successor insert, or the commit fails.
    pub fn rotate_refresh_token(
        &self,
        presented_hash: &str,
        successor: &RefreshToken,
        now: DateTime<Utc>,
    ) -> DbResult<RefreshTokenConsumeOutcome> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        let consumed_refresh_token_count = tx.execute(
            "UPDATE refresh_tokens SET consumed_at = ?2
             WHERE token_hash = ?1 AND consumed_at IS NULL",
            params![presented_hash, now],
        )?;
        let outcome = if consumed_refresh_token_count == 1 {
            let params = token_named_sql_params(successor);
            tx.execute(&build_insert_sql("refresh_tokens", &params), &params)?;
            RefreshTokenConsumeOutcome::Consumed
        } else {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM refresh_tokens WHERE token_hash = ?1)",
                params![presented_hash],
                |row| row.get(0),
            )?;
            if exists {
                RefreshTokenConsumeOutcome::Replayed
            } else {
                RefreshTokenConsumeOutcome::NotFound
            }
        };
        tx.commit()?;
        Ok(outcome)
    }

    /// End a token family by pulling its `expires_at` back to `now`, and
    /// stamp its still-live token consumed at the same instant so no row in
    /// a dead family looks live. Used by reuse detection. Rows are kept (not
    /// deleted) so the lineage stays auditable and replayed tokens still
    /// resolve to their dead family. The `consumed_at IS NULL` guard keeps
    /// genuine consumption stamps intact.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, either update,
    /// or the commit fails.
    pub fn expire_refresh_token_family(&self, family_id: &str, now: DateTime<Utc>) -> DbResult<()> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        tx.execute(
            "UPDATE refresh_token_families SET expires_at = ?2 WHERE family_id = ?1",
            params![family_id, now],
        )?;
        tx.execute(
            "UPDATE refresh_tokens SET consumed_at = ?2
             WHERE family_id = ?1 AND consumed_at IS NULL",
            params![family_id, now],
        )?;
        tx.commit()
    }

    /// End every refresh-token family issued to a client, with the same
    /// expire-and-stamp semantics as [`Self::expire_refresh_token_family`] —
    /// used when the Owner revokes a grant, so standing consent and standing
    /// credentials die together.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, either update,
    /// or the commit fails.
    pub fn expire_refresh_token_families_for_client(
        &self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> DbResult<()> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        tx.execute(
            "UPDATE refresh_tokens SET consumed_at = ?2
             WHERE consumed_at IS NULL AND family_id IN
                 (SELECT family_id FROM refresh_token_families WHERE client_id = ?1)",
            params![client_id, now],
        )?;
        tx.execute(
            "UPDATE refresh_token_families SET expires_at = ?2 WHERE client_id = ?1",
            params![client_id, now],
        )?;
        tx.commit()
    }

    /// End every refresh-token family minted from a given authorization code
    /// (identified by the code's hash), with the same expire-and-stamp
    /// semantics as [`Self::expire_refresh_token_family`]. Used by
    /// authorization-code reuse detection (RFC 6749 §4.1.2): a detectably
    /// replayed code revokes the refresh lineage its first redemption produced.
    /// A code that never minted a family (no `offline_access`, or never
    /// existed) matches no row and the call is a no-op.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, either update,
    /// or the commit fails.
    pub fn expire_refresh_token_families_for_authorization_code(
        &self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> DbResult<()> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        tx.execute(
            "UPDATE refresh_tokens SET consumed_at = ?2
             WHERE consumed_at IS NULL AND family_id IN
                 (SELECT family_id FROM refresh_token_families
                  WHERE authorization_code_hash = ?1)",
            params![authorization_code_hash, now],
        )?;
        tx.execute(
            "UPDATE refresh_token_families SET expires_at = ?2
             WHERE authorization_code_hash = ?1",
            params![authorization_code_hash, now],
        )?;
        tx.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp};
    use crate::db_utils::JsonColumn;
    use proptest::prelude::*;

    fn arb_family() -> impl Strategy<Value = RefreshTokenFamily> {
        (
            "[a-zA-Z0-9-]{1,36}",
            "[a-zA-Z0-9_-]{1,32}",
            prop::collection::vec("[a-z][a-z0-9_/.*]{0,15}", 0..5),
            prop::option::of("[a-zA-Z0-9-]{1,32}"),
            arb_timestamp(),
            arb_timestamp(),
            prop::option::of("[A-Za-z0-9_-]{43}"),
        )
            .prop_map(
                |(
                    family_id,
                    client_id,
                    scopes,
                    patient,
                    issued_at,
                    expires_at,
                    authorization_code_hash,
                )| {
                    RefreshTokenFamily {
                        family_id,
                        client_id,
                        scopes: JsonColumn(scopes),
                        patient,
                        issued_at,
                        expires_at,
                        authorization_code_hash,
                    }
                },
            )
    }

    fn arb_token_in_family(family_id: &str) -> impl Strategy<Value = RefreshToken> {
        let family_id = family_id.to_string();
        ("[a-zA-Z0-9_-]{1,43}", arb_timestamp(), arb_opt_timestamp()).prop_map(
            move |(token_hash, issued_at, consumed_at)| RefreshToken {
                token_hash,
                family_id: family_id.clone(),
                issued_at,
                consumed_at,
            },
        )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        #[test]
        fn insert_and_fetch_round_trip(
            family in arb_family(),
            token in arb_token_in_family("family-under-test"),
        ) {
            let family = RefreshTokenFamily { family_id: "family-under-test".to_string(), ..family };
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store
                .insert_refresh_token_family(&family, &token)
                .expect("insert");
            let (fetched_token, fetched_family) = store
                .refresh_token_with_family_by_hash(&token.token_hash)
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched_token, token);
            prop_assert_eq!(fetched_family, family);
        }

        #[test]
        fn consume_transitions_live_to_replayed(
            family in arb_family(),
            token in arb_token_in_family("family-under-test"),
        ) {
            let family = RefreshTokenFamily { family_id: "family-under-test".to_string(), ..family };
            let live = RefreshToken { consumed_at: None, ..token };
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store.insert_refresh_token_family(&family, &live).expect("insert");
            let now = Utc::now();
            prop_assert!(matches!(
                store.consume_refresh_token(&live.token_hash, now).expect("first consume"),
                RefreshTokenConsumeOutcome::Consumed
            ));
            prop_assert!(matches!(
                store.consume_refresh_token(&live.token_hash, now).expect("second consume"),
                RefreshTokenConsumeOutcome::Replayed
            ));
        }
    }

    #[test]
    fn consume_of_unknown_hash_is_not_found() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        assert!(matches!(
            store
                .consume_refresh_token("never-issued", Utc::now())
                .expect("consume"),
            RefreshTokenConsumeOutcome::NotFound
        ));
    }

    // Foreign-key enforcement (`PRAGMA foreign_keys = ON`): a refresh token
    // whose family does not exist is rejected at insert time instead of
    // becoming an orphan that later reads as "not found" (so a genuine replay
    // of such a token would fail to revoke anything).
    #[test]
    fn insert_refresh_token_rejects_orphan_without_family() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        let err = store
            .insert_refresh_token(&sample_token("orphan", "no-such-family"))
            .expect_err("orphan insert must violate the foreign key");
        assert!(
            matches!(
                err,
                rusqlite::Error::SqliteFailure(e, _)
                    if e.code == rusqlite::ErrorCode::ConstraintViolation
            ),
            "expected a foreign-key constraint violation, got {err:?}"
        );
    }

    // Rotation consumes the presented token and inserts its successor in one
    // transaction; a replay of the presented token is detected and inserts no
    // further successor.
    #[test]
    fn rotate_consumes_presented_and_inserts_successor_atomically() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .insert_refresh_token_family(
                &sample_family("fam", "client"),
                &sample_token("live", "fam"),
            )
            .expect("insert family");
        let now = Utc::now();

        assert!(matches!(
            store
                .rotate_refresh_token("live", &sample_token("successor", "fam"), now)
                .expect("rotate"),
            RefreshTokenConsumeOutcome::Consumed
        ));
        let presented = store
            .refresh_token_by_hash("live")
            .expect("q")
            .expect("row");
        assert_eq!(presented.consumed_at, Some(now));
        let successor = store
            .refresh_token_by_hash("successor")
            .expect("q")
            .expect("row");
        assert_eq!(successor.consumed_at, None);

        assert!(matches!(
            store
                .rotate_refresh_token("live", &sample_token("successor2", "fam"), now)
                .expect("rotate replay"),
            RefreshTokenConsumeOutcome::Replayed
        ));
        assert!(store
            .refresh_token_by_hash("successor2")
            .expect("q")
            .is_none());
    }

    fn sample_family(family_id: &str, client_id: &str) -> RefreshTokenFamily {
        RefreshTokenFamily {
            family_id: family_id.to_string(),
            client_id: client_id.to_string(),
            scopes: JsonColumn(vec!["read".to_string()]),
            patient: None,
            issued_at: Utc::now(),
            expires_at: Utc::now() + chrono::Duration::days(90),
            authorization_code_hash: None,
        }
    }

    fn sample_token(token_hash: &str, family_id: &str) -> RefreshToken {
        RefreshToken {
            token_hash: token_hash.to_string(),
            family_id: family_id.to_string(),
            issued_at: Utc::now(),
            consumed_at: None,
        }
    }

    #[test]
    fn expire_family_pulls_deadline_back_and_stamps_the_live_token() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .insert_refresh_token_family(
                &sample_family("family-a", "client-1"),
                &sample_token("token-1", "family-a"),
            )
            .expect("insert family-a");
        store
            .insert_refresh_token(&sample_token("token-2", "family-a"))
            .expect("insert token-2");
        let untouched = sample_family("family-b", "client-1");
        store
            .insert_refresh_token_family(&untouched, &sample_token("other", "family-b"))
            .expect("insert family-b");
        // token-1 was genuinely redeemed before the revocation — its stamp
        // must survive the family kill untouched.
        let redeemed_at = Utc::now();
        assert!(matches!(
            store
                .consume_refresh_token("token-1", redeemed_at)
                .expect("consume"),
            RefreshTokenConsumeOutcome::Consumed
        ));

        let revoked_at = Utc::now();
        store
            .expire_refresh_token_family("family-a", revoked_at)
            .expect("expire");

        // Rows are kept — the lineage stays auditable — with the family's
        // deadline pulled back to the revocation instant.
        let (redeemed_token, family) = store
            .refresh_token_with_family_by_hash("token-1")
            .expect("query")
            .expect("row present");
        assert_eq!(family.expires_at, revoked_at);
        assert_eq!(redeemed_token.consumed_at, Some(redeemed_at));
        // The live token is stamped at the revocation instant, so nothing in
        // a dead family looks live.
        let (live_token, _) = store
            .refresh_token_with_family_by_hash("token-2")
            .expect("query")
            .expect("row present");
        assert_eq!(live_token.consumed_at, Some(revoked_at));
        // The sibling family is untouched.
        let (other_token, other_family) = store
            .refresh_token_with_family_by_hash("other")
            .expect("query")
            .expect("row present");
        assert_eq!(other_family.expires_at, untouched.expires_at);
        assert_eq!(other_token.consumed_at, None);
    }

    #[test]
    fn expire_for_client_spares_other_clients() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .insert_refresh_token_family(
                &sample_family("family-a", "client-1"),
                &sample_token("token-1", "family-a"),
            )
            .expect("insert client-1 family");
        let untouched = sample_family("family-b", "client-2");
        store
            .insert_refresh_token_family(&untouched, &sample_token("other", "family-b"))
            .expect("insert client-2 family");

        let revoked_at = Utc::now();
        store
            .expire_refresh_token_families_for_client("client-1", revoked_at)
            .expect("expire");

        let (token, family) = store
            .refresh_token_with_family_by_hash("token-1")
            .expect("query")
            .expect("row present");
        assert_eq!(family.expires_at, revoked_at);
        assert_eq!(token.consumed_at, Some(revoked_at));
        let (other_token, other_family) = store
            .refresh_token_with_family_by_hash("other")
            .expect("query")
            .expect("row present");
        assert_eq!(other_family.expires_at, untouched.expires_at);
        assert_eq!(other_token.consumed_at, None);
    }
}
