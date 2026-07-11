//! `refresh_token_families` / `refresh_tokens` queries — the rotating
//! refresh-token lineage (RFC 6749 §6, OAuth 2.1 rotation semantics), loaded
//! and stored as [`RefreshTokenFamily`] / [`RefreshToken`].

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::db::schema::{refresh_token_families, refresh_tokens};
use crate::db::GatekeeperStore;
use crate::domain::error::GatekeeperError;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};

/// Outcome of attempting to consume a refresh token.
///
/// `#[must_use]`: ignoring a `Replayed` outcome would skip the family
/// revocation that reuse detection depends on, so the result must always be
/// inspected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
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

/// Consume-or-probe, shared by [`GatekeeperStore::consume_refresh_token`] and
/// [`GatekeeperStore::rotate_refresh_token`]: stamp the live row consumed, and
/// when no live row matched, probe whether the hash exists at all to tell a
/// replay from a miss. Runs inside the caller's transaction.
fn consume_within_transaction(
    conn: &mut diesel::sqlite::SqliteConnection,
    token_hash_value: &str,
    now: DateTime<Utc>,
) -> Result<RefreshTokenConsumeOutcome, diesel::result::Error> {
    let affected = diesel::update(
        refresh_tokens::table
            .find(token_hash_value)
            .filter(refresh_tokens::consumed_at.is_null()),
    )
    .set(refresh_tokens::consumed_at.eq(now))
    .execute(conn)?;
    if affected == 1 {
        return Ok(RefreshTokenConsumeOutcome::Consumed);
    }
    let exists: bool = diesel::select(diesel::dsl::exists(
        refresh_tokens::table.find(token_hash_value),
    ))
    .get_result(conn)?;
    Ok(if exists {
        RefreshTokenConsumeOutcome::Replayed
    } else {
        RefreshTokenConsumeOutcome::NotFound
    })
}

impl GatekeeperStore {
    /// Persist a new refresh-token family alongside its first token — one
    /// transaction, since a family with no token (or a token with no family)
    /// is unrepresentable on purpose.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the transaction or either insert fails.
    pub fn insert_refresh_token_family(
        &self,
        family: &RefreshTokenFamily,
        first_token: &RefreshToken,
    ) -> Result<(), GatekeeperError> {
        let mut conn = self.conn()?;
        conn.transaction(|conn| {
            diesel::insert_into(refresh_token_families::table)
                .values(family.clone())
                .execute(conn)?;
            diesel::insert_into(refresh_tokens::table)
                .values(first_token.clone())
                .execute(conn)?;
            Ok(())
        })
        .map_err(|e: diesel::result::Error| {
            GatekeeperError::backend("insert_refresh_token_family failed", e)
        })
    }

    /// Persist the successor token in an existing family's rotation.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the insert fails (for example a
    /// unique-constraint violation on the token hash, or a foreign-key
    /// violation for an unknown family).
    pub fn insert_refresh_token(&self, token: &RefreshToken) -> Result<(), GatekeeperError> {
        diesel::insert_into(refresh_tokens::table)
            .values(token.clone())
            .execute(&mut self.conn()?)
            .map_err(|e| GatekeeperError::backend("insert_refresh_token failed", e))?;
        Ok(())
    }

    /// Resolve a presented token hash to its row plus the owning family in
    /// one JOIN. Consumed tokens resolve too — the caller distinguishes a
    /// live token from a replayed one via `consumed_at`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the join query fails or a returned row
    /// cannot be mapped to a [`RefreshToken`]/[`RefreshTokenFamily`] pair.
    pub fn refresh_token_with_family_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
        refresh_tokens::table
            .inner_join(refresh_token_families::table)
            .filter(refresh_tokens::token_hash.eq(token_hash))
            .select((RefreshToken::as_select(), RefreshTokenFamily::as_select()))
            .first(&mut self.conn()?)
            .optional()
            .map_err(|e| GatekeeperError::backend("refresh_token_with_family_by_hash failed", e))
    }

    /// Look up a single token by hash — enough for callers that don't need
    /// the family facts.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the select query fails or a returned
    /// row cannot be mapped to a [`RefreshToken`].
    pub fn refresh_token_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<RefreshToken>, GatekeeperError> {
        refresh_tokens::table
            .find(token_hash)
            .select(RefreshToken::as_select())
            .first(&mut self.conn()?)
            .optional()
            .map_err(|e| GatekeeperError::backend("refresh_token_by_hash failed", e))
    }

    /// Atomically consume a live refresh token, reporting which
    /// of the three [`RefreshTokenConsumeOutcome`] states the row was in. The
    /// UPDATE's `consumed_at IS NULL` guard and the fallback existence probe
    /// run in one transaction, so a concurrent redeemer of the same token
    /// sees `Replayed`, never a torn state.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the transaction, the update, or the
    /// existence probe fails.
    pub fn consume_refresh_token(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
        let mut conn = self.conn()?;
        conn.transaction(|conn| consume_within_transaction(conn, token_hash, now))
            .map_err(|e: diesel::result::Error| {
                GatekeeperError::backend("consume_refresh_token failed", e)
            })
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
    /// [`GatekeeperError::Backend`] if the transaction, the update, the
    /// existence probe, or the successor insert fails.
    pub fn rotate_refresh_token(
        &self,
        presented_hash: &str,
        successor: &RefreshToken,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
        let mut conn = self.conn()?;
        conn.transaction(|conn| {
            let outcome = consume_within_transaction(conn, presented_hash, now)?;
            if outcome == RefreshTokenConsumeOutcome::Consumed {
                diesel::insert_into(refresh_tokens::table)
                    .values(successor.clone())
                    .execute(conn)?;
            }
            Ok(outcome)
        })
        .map_err(|e: diesel::result::Error| {
            GatekeeperError::backend("rotate_refresh_token failed", e)
        })
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
    /// [`GatekeeperError::Backend`] if the transaction or either update fails.
    pub fn expire_refresh_token_family(
        &self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let mut conn = self.conn()?;
        conn.transaction(|conn| {
            diesel::update(refresh_token_families::table.find(family_id))
                .set(refresh_token_families::expires_at.eq(now))
                .execute(conn)?;
            diesel::update(
                refresh_tokens::table
                    .filter(refresh_tokens::family_id.eq(family_id))
                    .filter(refresh_tokens::consumed_at.is_null()),
            )
            .set(refresh_tokens::consumed_at.eq(now))
            .execute(conn)?;
            Ok(())
        })
        .map_err(|e: diesel::result::Error| {
            GatekeeperError::backend("expire_refresh_token_family failed", e)
        })
    }

    /// End every refresh-token family issued to a client, with the same
    /// expire-and-stamp semantics as [`Self::expire_refresh_token_family`] —
    /// used when the Owner revokes a grant, so standing consent and standing
    /// credentials die together.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the transaction or either update fails.
    pub fn expire_refresh_token_families_for_client(
        &self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let mut conn = self.conn()?;
        conn.transaction(|conn| {
            diesel::update(
                refresh_tokens::table
                    .filter(refresh_tokens::consumed_at.is_null())
                    .filter(
                        refresh_tokens::family_id.eq_any(
                            refresh_token_families::table
                                .filter(refresh_token_families::client_id.eq(client_id))
                                .select(refresh_token_families::family_id),
                        ),
                    ),
            )
            .set(refresh_tokens::consumed_at.eq(now))
            .execute(conn)?;
            diesel::update(
                refresh_token_families::table
                    .filter(refresh_token_families::client_id.eq(client_id)),
            )
            .set(refresh_token_families::expires_at.eq(now))
            .execute(conn)?;
            Ok(())
        })
        .map_err(|e: diesel::result::Error| {
            GatekeeperError::backend("expire_refresh_token_families_for_client failed", e)
        })
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
    /// [`GatekeeperError::Backend`] if the transaction or either update fails.
    pub fn expire_refresh_token_families_for_authorization_code(
        &self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let mut conn = self.conn()?;
        conn.transaction(|conn| {
            diesel::update(
                refresh_tokens::table
                    .filter(refresh_tokens::consumed_at.is_null())
                    .filter(
                        refresh_tokens::family_id.eq_any(
                            refresh_token_families::table
                                .filter(
                                    refresh_token_families::authorization_code_hash
                                        .eq(authorization_code_hash),
                                )
                                .select(refresh_token_families::family_id),
                        ),
                    ),
            )
            .set(refresh_tokens::consumed_at.eq(now))
            .execute(conn)?;
            diesel::update(refresh_token_families::table.filter(
                refresh_token_families::authorization_code_hash.eq(authorization_code_hash),
            ))
            .set(refresh_token_families::expires_at.eq(now))
            .execute(conn)?;
            Ok(())
        })
        .map_err(|e: diesel::result::Error| {
            GatekeeperError::backend(
                "expire_refresh_token_families_for_authorization_code failed",
                e,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp};
    use crate::domain::error::GatekeeperError;
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
            prop::option::of("[a-zA-Z0-9-]{1,36}"),
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
                    grant_id,
                )| {
                    RefreshTokenFamily {
                        family_id,
                        client_id,
                        scopes,
                        patient,
                        issued_at,
                        expires_at,
                        authorization_code_hash,
                        grant_id,
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
    // of such a token would fail to revoke anything). The store surfaces it as
    // the opaque Backend whose text names the constraint.
    #[test]
    fn insert_refresh_token_rejects_orphan_without_family() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        let err = store
            .insert_refresh_token(&sample_token("orphan", "no-such-family"))
            .expect_err("orphan insert must violate the foreign key");
        assert!(
            matches!(
                &err,
                GatekeeperError::Backend { source, .. }
                    if source.to_uppercase().contains("FOREIGN KEY")
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
            scopes: vec!["read".to_string()],
            patient: None,
            issued_at: Utc::now(),
            expires_at: Utc::now() + chrono::Duration::days(90),
            authorization_code_hash: None,
            grant_id: None,
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
