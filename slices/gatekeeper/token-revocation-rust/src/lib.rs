//! `token-revocation-rust` — the shared token-revocation store.
//!
//! A gatekeeper access token is a stateless, **multi-use** bearer: the SPA
//! reuses one `wf_auth` cookie token across many FHIR calls. So a token's `jti`
//! (RFC 7519 §4.1.7) is an **identity handle for revocation**, not a one-shot
//! nonce — nothing is rejected unless the `jti` (or the subject's whole token
//! cohort) has been *explicitly* revoked. That keeps ordinary reuse intact
//! while still letting a leaked cookie be invalidated before its `exp`.
//!
//! This crate owns the storage only — two tables on the shared
//! `wildflower.sqlite` under the `token_revocation` migration namespace:
//!
//! - [`revoked_jtis`](#) — a per-token denylist keyed by `jti`.
//! - [`revocation_epochs`](#) — a per-subject `not_before` lever for bulk
//!   revocation without a per-issued-`jti` registry.
//!
//! The verdict is: **revoked** iff `jti ∈ revoked_jtis` **or**
//! `iat < not_before(subject)`.
//!
//! It carries no auth policy and no helios dependency, so both enforcement
//! points can read it in-process without pulling each other in: `gatekeeper-rust`
//! (the gate + the revoke control surface) and `emr-rust`'s HFS `JtiCache`
//! adapter (per-`jti` denylist only — helios hands it just `(jti, expires_at)`).

use chrono::{DateTime, Utc};
use persistence_rust::{Connection, DbResult};
use rusqlite::{params, OptionalExtension};

/// Migration namespace for the revocation tables in the shared database. Kept
/// distinct from `gatekeeper` so the two slices' `schema_migrations` versions
/// don't collide (see [`persistence_rust::run_migrations`]).
const NAMESPACE: &str = "token_revocation";

/// Ordered, append-only schema migrations. The array index is the recorded
/// `schema_migrations` version — never reorder or rewrite a shipped entry.
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/001_revoked_jtis.sql"),
    include_str!("migrations/002_revocation_epochs.sql"),
];

/// Handle onto the shared token-revocation store. Cheap to clone (the inner
/// [`Connection`] is an `Arc`), so the host builds one and hands a clone to
/// each enforcement point.
#[derive(Clone)]
pub struct RevocationStore {
    conn: Connection,
}

impl RevocationStore {
    /// Wrap the shared `conn` and apply the (namespaced) revocation migrations
    /// onto it. Idempotent — safe to call on every boot; the host calls it once
    /// and clones the handle.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if applying the migrations fails.
    pub fn new(conn: Connection) -> DbResult<Self> {
        {
            let mut guard = conn.lock();
            persistence_rust::run_migrations(&mut guard, NAMESPACE, MIGRATIONS)?;
        }
        Ok(Self { conn })
    }

    /// Open a private in-memory shared connection and wrap it — for tests.
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory connection can't be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Ok(Self::new(Connection::open_in_memory()?)?)
    }

    /// The **complete** revocation check, for the enforcement point that holds
    /// full claims (the gatekeeper gate): a token is revoked iff its `jti` is on
    /// the denylist **or** its `issued_at` predates the subject's revocation
    /// epoch.
    ///
    /// `jti`/`issued_at` are `Option` because verification tolerates legacy
    /// tokens minted before gatekeeper wrote a `jti`. A missing `jti` simply
    /// can't be denylisted individually. A missing `issued_at` under an *active*
    /// subject epoch **fails closed** (treated as revoked): a token that can't
    /// prove it was issued after the bump must not slip through a deliberate
    /// bulk revocation.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if either lookup query fails.
    pub fn is_revoked(
        &self,
        jti: Option<&str>,
        issued_at: Option<DateTime<Utc>>,
        subject: &str,
    ) -> DbResult<bool> {
        if let Some(jti) = jti {
            if self.is_revoked_by_jti(jti)? {
                return Ok(true);
            }
        }
        let Some(not_before) = self.subject_not_before(subject)? else {
            return Ok(false);
        };
        // Under an active epoch: allow only a token that proves an `iat` at or
        // after the bump; a missing `iat` fails closed.
        Ok(match issued_at {
            Some(iat) => iat.timestamp() < not_before,
            None => true,
        })
    }

    /// The **denylist-only** check, for the enforcement point that sees just the
    /// `jti` (emr-rust's HFS `JtiCache` adapter — helios never hands it `sub` or
    /// `iat`, so it can't run the epoch half; the gate, which runs first, does).
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the lookup query fails.
    pub fn is_revoked_by_jti(&self, jti: &str) -> DbResult<bool> {
        self.conn.lock().query_row(
            "SELECT EXISTS(SELECT 1 FROM revoked_jtis WHERE jti = ?1)",
            params![jti],
            |row| row.get(0),
        )
    }

    /// Add `jti` to the denylist, recording the token's own `expires_at` (so the
    /// sweep can later drop it) and an audit `reason`. Idempotent: re-revoking a
    /// `jti` keeps the original row (`ON CONFLICT DO NOTHING`) — the token is
    /// already revoked; the first record is the operative one.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the insert fails.
    pub fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> DbResult<()> {
        self.conn.lock().execute(
            "INSERT INTO revoked_jtis (jti, expires_at, revoked_at, reason)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(jti) DO NOTHING",
            params![jti, expires_at.timestamp(), Utc::now().timestamp(), reason],
        )?;
        Ok(())
    }

    /// Bump `subject`'s revocation epoch to `not_before`, invalidating every
    /// token that subject holds whose `iat` predates it — bulk revocation in one
    /// upsert. **Monotonic**: a `not_before` earlier than the stored one is
    /// ignored (`MAX`), so revocation can never be walked back by a stale or
    /// out-of-order call.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the upsert fails.
    pub fn bump_subject_epoch(&self, subject: &str, not_before: DateTime<Utc>) -> DbResult<()> {
        self.conn.lock().execute(
            "INSERT INTO revocation_epochs (subject, not_before, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(subject) DO UPDATE SET
                 not_before = MAX(revocation_epochs.not_before, excluded.not_before),
                 updated_at = excluded.updated_at",
            params![subject, not_before.timestamp(), Utc::now().timestamp()],
        )?;
        Ok(())
    }

    /// Delete denylist rows whose token has already expired (`expires_at < now`)
    /// — a token past its `exp` is rejected by expiry validation regardless, so
    /// its denylist row is redundant. Returns the number of rows purged. The
    /// per-subject epochs are *not* purged: they're one small row per subject and
    /// must outlive any token they revoke.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the delete fails.
    pub fn purge_expired(&self, now: DateTime<Utc>) -> DbResult<usize> {
        self.conn.lock().execute(
            "DELETE FROM revoked_jtis WHERE expires_at < ?1",
            params![now.timestamp()],
        )
    }

    /// The subject's revocation-epoch `not_before` as Unix epoch seconds, if one
    /// has been set.
    fn subject_not_before(&self, subject: &str) -> DbResult<Option<i64>> {
        self.conn
            .lock()
            .query_row(
                "SELECT not_before FROM revocation_epochs WHERE subject = ?1",
                params![subject],
                |row| row.get(0),
            )
            .optional()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use proptest::prelude::*;

    fn store() -> RevocationStore {
        RevocationStore::open_in_memory().expect("open in-memory store")
    }

    #[test]
    fn unknown_jti_is_not_revoked() {
        let store = store();
        assert!(!store.is_revoked_by_jti("never-seen").expect("query"));
        assert!(!store
            .is_revoked(Some("never-seen"), Some(Utc::now()), "client")
            .expect("query"));
    }

    #[test]
    fn revoked_jti_is_revoked_by_both_checks() {
        let store = store();
        let exp = Utc::now() + Duration::hours(1);
        store.revoke_jti("jti-1", exp, "logout").expect("revoke");
        assert!(store.is_revoked_by_jti("jti-1").expect("query"));
        assert!(store
            .is_revoked(Some("jti-1"), Some(Utc::now()), "client")
            .expect("query"));
        // A different jti for the same subject is untouched.
        assert!(!store.is_revoked_by_jti("jti-2").expect("query"));
    }

    #[test]
    fn revoke_jti_is_idempotent() {
        let store = store();
        let exp = Utc::now() + Duration::hours(1);
        store.revoke_jti("jti-1", exp, "logout").expect("first");
        // A second revoke (e.g. a double logout) must not error on the PK.
        store.revoke_jti("jti-1", exp, "admin").expect("second");
        assert!(store.is_revoked_by_jti("jti-1").expect("query"));
    }

    #[test]
    fn epoch_revokes_tokens_issued_before_not_before() {
        let store = store();
        let not_before = Utc::now();
        store
            .bump_subject_epoch("client", not_before)
            .expect("bump");
        // Issued a minute before the bump → revoked.
        let before = not_before - Duration::minutes(1);
        assert!(store
            .is_revoked(Some("fresh-jti"), Some(before), "client")
            .expect("query"));
        // Issued a minute after the bump → allowed (jti not denylisted).
        let after = not_before + Duration::minutes(1);
        assert!(!store
            .is_revoked(Some("fresh-jti"), Some(after), "client")
            .expect("query"));
        // A different subject is unaffected by this subject's epoch.
        assert!(!store
            .is_revoked(Some("fresh-jti"), Some(before), "other-client")
            .expect("query"));
    }

    #[test]
    fn epoch_boundary_is_iat_at_or_after_not_before() {
        let store = store();
        let not_before = Utc::now();
        store
            .bump_subject_epoch("client", not_before)
            .expect("bump");
        // `iat == not_before` is allowed (revoked is strictly `iat < not_before`).
        assert!(!store
            .is_revoked(Some("j"), Some(not_before), "client")
            .expect("query"));
        // One second earlier is revoked.
        let one_earlier = not_before - Duration::seconds(1);
        assert!(store
            .is_revoked(Some("j"), Some(one_earlier), "client")
            .expect("query"));
    }

    #[test]
    fn epoch_with_missing_iat_fails_closed() {
        let store = store();
        store
            .bump_subject_epoch("client", Utc::now())
            .expect("bump");
        // A token under an active epoch that can't prove its issue time is
        // treated as revoked.
        assert!(store.is_revoked(Some("j"), None, "client").expect("query"));
        // But with no epoch for the subject, a missing `iat` is not revoked.
        assert!(!store.is_revoked(Some("j"), None, "other").expect("query"));
    }

    #[test]
    fn bump_subject_epoch_is_monotonic() {
        let store = store();
        let later = Utc::now();
        let earlier = later - Duration::hours(1);
        // Set a late epoch, then attempt to move it backwards.
        store.bump_subject_epoch("client", later).expect("late");
        store.bump_subject_epoch("client", earlier).expect("early");
        // A token issued between `earlier` and `later` must stay revoked — the
        // backwards bump was ignored.
        let between = later - Duration::minutes(30);
        assert!(store
            .is_revoked(Some("j"), Some(between), "client")
            .expect("query"));
    }

    #[test]
    fn purge_drops_expired_rows_and_keeps_live_ones() {
        let store = store();
        let now = Utc::now();
        store
            .revoke_jti("expired", now - Duration::minutes(1), "logout")
            .expect("revoke expired");
        store
            .revoke_jti("live", now + Duration::hours(1), "logout")
            .expect("revoke live");
        let purged = store.purge_expired(now).expect("purge");
        assert_eq!(purged, 1, "exactly the expired row is dropped");
        assert!(!store.is_revoked_by_jti("expired").expect("query"));
        assert!(store.is_revoked_by_jti("live").expect("query"));
    }

    #[test]
    fn migration_is_idempotent_and_creates_tables() {
        // Re-wrapping the same shared connection re-runs migrations; the second
        // pass must be a no-op (a re-run `CREATE TABLE` would error otherwise).
        let conn = Connection::open_in_memory().expect("open");
        RevocationStore::new(conn.clone()).expect("first");
        RevocationStore::new(conn.clone()).expect("second");
        let guard = conn.lock();
        for table in ["revoked_jtis", "revocation_epochs"] {
            let exists: bool = guard
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |_| Ok(true),
                )
                .optional()
                .expect("query")
                .unwrap_or(false);
            assert!(exists, "missing table {table}");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// Whatever the inputs: a `jti` reads back revoked iff it was revoked,
        /// and the denylist never reports a `jti` it never saw.
        #[test]
        fn denylist_reflects_exactly_what_was_revoked(
            revoked in prop::collection::hash_set("[a-zA-Z0-9-]{1,36}", 0..8),
            probe in "[a-zA-Z0-9-]{1,36}",
        ) {
            let store = store();
            let exp = Utc::now() + Duration::hours(1);
            for jti in &revoked {
                store.revoke_jti(jti, exp, "test").expect("revoke");
            }
            prop_assert_eq!(
                store.is_revoked_by_jti(&probe).expect("query"),
                revoked.contains(&probe)
            );
        }
    }
}
