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

use chrono::{DateTime, Duration, Utc};
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
    backend: Backend,
}

/// How a [`RevocationStore`] resolves its checks. Production is
/// [`Backend::Sqlite`]; [`Backend::AlwaysAllow`] is a no-op double
/// ([`RevocationStore::always_allow`]) for callers whose auth path never
/// consults revocation, so they needn't stand up even an in-memory database
/// just to satisfy the signature.
#[derive(Clone)]
enum Backend {
    /// SQLite-backed: the real per-`jti` denylist + per-subject epoch tables.
    Sqlite(Connection),
    /// Never reports a token as revoked; writes are no-ops. Test/dev only.
    AlwaysAllow,
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
        Ok(Self {
            backend: Backend::Sqlite(conn),
        })
    }

    /// Open a private in-memory shared connection and wrap it — for tests that
    /// exercise real revocation behaviour (denylist / epoch / purge).
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory connection can't be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Ok(Self::new(Connection::open_in_memory()?)?)
    }

    /// A no-op store that never reports a token as revoked and whose writes do
    /// nothing. For callers whose auth path never consults revocation — HFS with
    /// auth off, the dev `serve` binary, the FHIR router tests — so they can
    /// satisfy `setup_fhir_r4`'s signature without standing up a real (even
    /// in-memory) SQLite store. **Never** wire this into a path that actually
    /// enforces revocation.
    pub fn always_allow() -> Self {
        Self {
            backend: Backend::AlwaysAllow,
        }
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
        let Backend::Sqlite(conn) = &self.backend else {
            return Ok(false);
        };
        conn.lock().query_row(
            "SELECT EXISTS(SELECT 1 FROM revoked_jtis WHERE jti = ?1)",
            params![jti],
            |row| row.get(0),
        )
    }

    /// Add `jti` to the denylist, recording the token's own `expires_at` (a sweep
    /// hint) and an audit `reason`. Idempotent. On a re-revoke the **audit fields
    /// stay first-write** (`revoked_at`/`reason` are the operative first record),
    /// but `expires_at` is bumped **monotonically** (`MAX`) — never walked back.
    /// Monotonicity is the safe direction: a later, more-correct `expires_at` can
    /// extend how long the row is retained, but a stale or too-early re-revoke can
    /// never shorten it and let the sweep drop the row while the token is still
    /// live. (A single too-early *first* `expires_at` is separately neutralised by
    /// the `revoked_at`-based retention floor in [`Self::purge_expired`].)
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the insert fails.
    pub fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> DbResult<()> {
        let Backend::Sqlite(conn) = &self.backend else {
            return Ok(());
        };
        conn.lock().execute(
            "INSERT INTO revoked_jtis (jti, expires_at, revoked_at, reason)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(jti) DO UPDATE SET
                 expires_at = MAX(revoked_jtis.expires_at, excluded.expires_at)",
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
        let Backend::Sqlite(conn) = &self.backend else {
            return Ok(());
        };
        conn.lock().execute(
            "INSERT INTO revocation_epochs (subject, not_before, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(subject) DO UPDATE SET
                 not_before = MAX(revocation_epochs.not_before, excluded.not_before),
                 updated_at = excluded.updated_at",
            params![subject, not_before.timestamp(), Utc::now().timestamp()],
        )?;
        Ok(())
    }

    /// Bulk-revoke every token `subject` currently holds — the "revoke as of
    /// now" lever behind the owner revocation endpoint's `subject` mode and grant
    /// revoke. Bumps the epoch to **one second past now**, not to now: a JWT
    /// `iat` is second-precision, so a token minted in the *current* second has
    /// `iat == now` and would survive the store's strict `iat < not_before`
    /// check. `now + 1s` catches the whole outstanding cohort, including a token
    /// minted this very second. Over-revoking the current second is exactly the
    /// intent of a bulk revoke (the subject re-earns access by re-authorizing).
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the upsert fails.
    pub fn revoke_subject_as_of_now(&self, subject: &str) -> DbResult<()> {
        self.bump_subject_epoch(subject, Utc::now() + Duration::seconds(1))
    }

    /// Delete denylist rows whose token is **guaranteed dead** — both its recorded
    /// `expires_at` has passed **and** it was revoked at least `max_token_ttl`
    /// ago. Returns the number of rows purged. Per-subject epochs are never purged
    /// (one small row per subject; must outlive any token they revoke).
    ///
    /// The `revoked_at + max_token_ttl` floor is the load-bearing half.
    /// `expires_at` is caller-supplied on the `POST /access/revocations` path, so
    /// a too-early value could otherwise let the sweep drop a row while the token
    /// is still live — silently un-revoking it. But a token revoked at
    /// `revoked_at` was minted no later than then (`iat ≤ revoked_at`), so its
    /// `exp = iat + ttl ≤ revoked_at + max_token_ttl`: once `now` is past that
    /// floor the token is expired regardless of what `expires_at` claims. Pass the
    /// **longest** access-token TTL the issuer mints as `max_token_ttl`.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the delete fails.
    pub fn purge_expired(&self, now: DateTime<Utc>, max_token_ttl: Duration) -> DbResult<usize> {
        let Backend::Sqlite(conn) = &self.backend else {
            return Ok(0);
        };
        let retention_floor = (now - max_token_ttl).timestamp();
        conn.lock().execute(
            "DELETE FROM revoked_jtis WHERE expires_at < ?1 AND revoked_at < ?2",
            params![now.timestamp(), retention_floor],
        )
    }

    /// The subject's revocation-epoch `not_before` as Unix epoch seconds, if one
    /// has been set.
    fn subject_not_before(&self, subject: &str) -> DbResult<Option<i64>> {
        let Backend::Sqlite(conn) = &self.backend else {
            return Ok(None);
        };
        conn.lock()
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
    fn revoke_subject_as_of_now_revokes_a_token_minted_this_second() {
        let store = store();
        // A token whose `iat` is *now* (same wall-clock second as the revoke).
        // A plain `bump_subject_epoch(subject, now)` would leave it live
        // (`iat == not_before`, not `<`); the `+1s` in `revoke_subject_as_of_now`
        // must catch it.
        let iat = Utc::now();
        store
            .revoke_subject_as_of_now("client")
            .expect("revoke as of now");
        assert!(
            store
                .is_revoked(Some("j"), Some(iat), "client")
                .expect("query"),
            "a token minted in the same second as the bulk revoke must be revoked"
        );
    }

    #[test]
    fn always_allow_never_revokes_and_writes_are_no_ops() {
        let store = RevocationStore::always_allow();
        // Writes succeed but change nothing.
        store
            .revoke_jti("jti-1", Utc::now() + Duration::hours(1), "test")
            .expect("revoke_jti no-op");
        store
            .bump_subject_epoch("client", Utc::now())
            .expect("bump no-op");
        store
            .revoke_subject_as_of_now("client")
            .expect("bulk no-op");
        // Nothing ever reads back revoked — including what we just "revoked".
        assert!(!store.is_revoked_by_jti("jti-1").expect("query"));
        assert!(!store
            .is_revoked(
                Some("jti-1"),
                Some(Utc::now() - Duration::hours(1)),
                "client"
            )
            .expect("query"));
        assert_eq!(
            store
                .purge_expired(Utc::now(), Duration::hours(2))
                .expect("purge"),
            0
        );
    }

    /// Read the stored `expires_at` (epoch seconds) for a `jti` directly, to
    /// assert the `ON CONFLICT` bump behaviour.
    fn stored_expires_at(store: &RevocationStore, jti: &str) -> i64 {
        let Backend::Sqlite(conn) = &store.backend else {
            panic!("sqlite-backed store expected");
        };
        conn.lock()
            .query_row(
                "SELECT expires_at FROM revoked_jtis WHERE jti = ?1",
                params![jti],
                |row| row.get(0),
            )
            .expect("row exists")
    }

    #[test]
    fn revoke_jti_bumps_expires_at_monotonically_on_conflict() {
        let store = store();
        let base = Utc::now();
        let late = base + Duration::hours(2);
        let early = base + Duration::minutes(10);
        // First revoke with the later expiry, then re-revoke with an earlier one:
        // the earlier value must NOT walk `expires_at` back (that would let the
        // sweep drop the row too soon).
        store.revoke_jti("j", late, "admin").expect("first");
        store
            .revoke_jti("j", early, "admin")
            .expect("second (earlier)");
        assert_eq!(
            stored_expires_at(&store, "j"),
            late.timestamp(),
            "an earlier re-revoke must not shorten retention"
        );
        // A still-later re-revoke DOES extend it (monotonic upward).
        let later = base + Duration::hours(5);
        store
            .revoke_jti("j", later, "admin")
            .expect("third (later)");
        assert_eq!(
            stored_expires_at(&store, "j"),
            later.timestamp(),
            "a later re-revoke extends retention"
        );
    }

    #[test]
    fn purge_keeps_a_recently_revoked_row_despite_a_too_early_expires_at() {
        // The core hardening: a too-early `expires_at` (e.g. a bad value on
        // `POST /access/revocations`) must not let the sweep drop the row while
        // the token could still be live. The `revoked_at + max_token_ttl` floor
        // holds it.
        let store = store();
        let now = Utc::now();
        // Revoked ~now, but with a bogus expiry a minute in the past.
        store
            .revoke_jti("leaked", now - Duration::minutes(1), "admin")
            .expect("revoke");
        // Sweep an hour later with a 2h max TTL: `expires_at` is long past, but
        // the row was revoked well under `max_token_ttl` ago, so it stays.
        let purged = store
            .purge_expired(now + Duration::hours(1), Duration::hours(2))
            .expect("purge");
        assert_eq!(purged, 0, "the retention floor must keep the row");
        assert!(
            store.is_revoked_by_jti("leaked").expect("query"),
            "a too-early expiresAt must not prematurely un-revoke a still-live token"
        );
    }

    #[test]
    fn purge_drops_rows_only_once_past_the_retention_floor() {
        let store = store();
        let now = Utc::now();
        let max_ttl = Duration::hours(2);
        // Both revoked ~now. `dead` claims a past expiry; `live` a far-future one.
        store
            .revoke_jti("dead", now - Duration::minutes(1), "logout")
            .expect("revoke dead");
        store
            .revoke_jti("live", now + Duration::hours(6), "logout")
            .expect("revoke live");
        // Sweep 3h later — past the 2h floor for both, so the floor no longer
        // protects either; only `expires_at` decides.
        let later = now + Duration::hours(3);
        let purged = store.purge_expired(later, max_ttl).expect("purge");
        assert_eq!(
            purged, 1,
            "only the row whose token is guaranteed dead drops"
        );
        assert!(!store.is_revoked_by_jti("dead").expect("query"));
        assert!(
            store.is_revoked_by_jti("live").expect("query"),
            "a row whose expires_at is still in the future survives"
        );
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
