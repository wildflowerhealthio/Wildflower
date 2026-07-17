use chrono::{DateTime, Duration, Utc};
use diesel::prelude::{Insertable, Queryable, Selectable};

use crate::db::refresh_tokens::{refresh_token_families, refresh_tokens};
use crate::db::shared::JsonStrings;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::{GatekeeperStore, GatekeeperTx};

/// Absolute lifetime of a refresh-token family, measured from the original
/// authorization. Rotation swaps generations but never extends this
/// deadline — past it the client re-runs the authorization flow.
pub const REFRESH_TOKEN_FAMILY_TTL: Duration = Duration::days(90);

/// One authorization's refresh-token lineage (RFC 6749 §6). The family owns
/// every fact shared by all the tokens rotated under it — client, scopes,
/// patient context, and the absolute deadline — so those are stated exactly
/// once. Tokens ([`RefreshToken`]) reference it by `family_id`.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = refresh_token_families)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct RefreshTokenFamily {
    /// Primary key — lineage id shared by every token descended from one
    /// authorization.
    pub family_id: String,
    /// Client the family was issued to; redemption is rejected for any other.
    pub client_id: String,
    /// Scopes carried forward to every access token minted from this family.
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub scopes: Vec<String>,
    /// SMART-on-FHIR patient context recorded at authorization, if any.
    pub patient: Option<String>,
    /// When the family was created (the original authorization).
    pub issued_at: DateTime<Utc>,
    /// Absolute deadline for the whole family — rotation never extends it;
    /// past this the client must re-run the authorization flow.
    pub expires_at: DateTime<Utc>,
    /// SHA-256 base64url hash of the authorization `code` that minted this
    /// family, or `None` for grants with no authorization code (the
    /// device-code flow). On a detected code replay the family is revoked via
    /// this hash (RFC 6749 §4.1.2 / OAuth 2.1 §4.1.2.1). The plaintext code is
    /// never stored.
    pub authorization_code_hash: Option<String>,
    /// The [`Grant`](crate::domain::grant::Grant) that authorized this family,
    /// for **both** flows — the plumbing a future "revoke exactly this device's
    /// session" ticket keys on. Written at family creation; read by nothing in
    /// v1. `None` when no matching grant was found at exchange time (e.g. a grant
    /// revoked between approval and the token poll). No FK: families outlive
    /// grants by design (expired in place, never deleted).
    pub grant_id: Option<String>,
}

/// One rotation of a refresh token. Presenting the plaintext at `/token`
/// with `grant_type=refresh_token` mints a fresh access token plus this
/// token's successor; the presented token is marked consumed. Replaying a
/// consumed token is treated as theft and revokes the whole
/// [`RefreshTokenFamily`] (OAuth 2.1 rotation semantics).
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = refresh_tokens)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct RefreshToken {
    /// Primary key — SHA-256 base64url digest of the plaintext token. The
    /// plaintext is returned to the client once and never stored.
    pub token_hash: String,
    /// The [`RefreshTokenFamily`] this token belongs to.
    pub family_id: String,
    /// When this token was minted.
    pub issued_at: DateTime<Utc>,
    /// Set when this token is redeemed. `None` means this is the family's
    /// single live token.
    pub consumed_at: Option<DateTime<Utc>>,
}

/// Outcome of attempting to consume a refresh token — the primitive shape the
/// [`GatekeeperStore`](crate::domain::GatekeeperStore) port returns, with the
/// theft-vs-miss decision left to the caller.
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

// The refresh-token rotation operations over the [`GatekeeperStore`] port — the
// OAuth `/token` endpoint's transaction scripts, co-located with the types they
// operate on (this module owns both the refresh-token vocabulary and its store
// operations). Trivial single-call reads/writes
// (`refresh_token_with_family_by_hash`, `expire_refresh_token_family*`) are not
// here — their callers hit the store method directly.

/// Persist a new refresh-token family plus its first token, sequencing the two
/// primitive inserts so a family never persists tokenless: the family row first,
/// then its token. No transaction — the token insert's foreign key rejects a
/// token whose family didn't land, so an out-of-order or partial write can't
/// leave a live tokenless family the redeemer would trust.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if either store write fails.
pub(crate) fn insert_refresh_token_family(
    store: &impl GatekeeperStore,
    family: &RefreshTokenFamily,
    first_token: &RefreshToken,
) -> Result<(), GatekeeperError> {
    store.insert_refresh_token_family_row(family)?;
    store.insert_refresh_token(first_token)
}

/// Atomically consume a live refresh token, reporting which of the three
/// [`RefreshTokenConsumeOutcome`] states the presented token was in. The guarded
/// stamp and the existence probe run in **one** transaction, so a concurrent
/// redeemer of the same token reads a single snapshot: exactly one caller stamps
/// the live row (`Consumed`), and a loser sees the row still present but no
/// longer live (`Replayed`) rather than a torn state; an unknown hash is
/// `NotFound`.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the transaction, the stamp, or the
/// existence probe fails.
pub(crate) fn consume_refresh_token(
    store: &impl GatekeeperStore,
    token_hash: &str,
    now: DateTime<Utc>,
) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
    store.transaction(|tx| {
        if tx.stamp_refresh_token_consumed_if_live(token_hash, now)? {
            Ok(RefreshTokenConsumeOutcome::Consumed)
        } else if tx.refresh_token_exists(token_hash)? {
            Ok(RefreshTokenConsumeOutcome::Replayed)
        } else {
            Ok(RefreshTokenConsumeOutcome::NotFound)
        }
    })
}

/// Rotate a refresh token: consume the presented token, and **only** if that
/// consume won (transitioned a live row) insert its successor. The consume is
/// itself atomic (see [`consume_refresh_token`]), so exactly one concurrent
/// redeemer sees `Consumed` and inserts a successor; a `Replayed`/`NotFound`
/// redeemer inserts nothing and the family is untouched. No wrapping transaction
/// spans the consume and the insert — the ordering (consume before insert) means
/// a failure of the second step leaves the presented token spent but no
/// successor, which the caller treats as a failed rotation, never a usable extra
/// token.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if a store write fails.
pub(crate) fn rotate_refresh_token(
    store: &impl GatekeeperStore,
    presented_hash: &str,
    successor: &RefreshToken,
    now: DateTime<Utc>,
) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
    let outcome = consume_refresh_token(store, presented_hash, now)?;
    if outcome == RefreshTokenConsumeOutcome::Consumed {
        store.insert_refresh_token(successor)?;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::FakeGatekeeperStore;

    fn family(family_id: &str) -> RefreshTokenFamily {
        RefreshTokenFamily {
            family_id: family_id.to_owned(),
            client_id: "client".to_owned(),
            scopes: vec!["read".to_owned()],
            patient: None,
            issued_at: Utc::now(),
            expires_at: Utc::now() + Duration::days(90),
            authorization_code_hash: None,
            grant_id: None,
        }
    }

    fn token(token_hash: &str, family_id: &str) -> RefreshToken {
        RefreshToken {
            token_hash: token_hash.to_owned(),
            family_id: family_id.to_owned(),
            issued_at: Utc::now(),
            consumed_at: None,
        }
    }

    #[test]
    fn insert_refresh_token_family_persists_family_and_first_token() {
        let store = FakeGatekeeperStore::default();
        insert_refresh_token_family(&store, &family("fam"), &token("t0", "fam")).unwrap();
        let (fetched_token, fetched_family) = store
            .refresh_token_with_family_by_hash("t0")
            .unwrap()
            .expect("family and token both persisted");
        assert_eq!(fetched_token.token_hash, "t0");
        assert_eq!(fetched_family.family_id, "fam");
    }

    #[test]
    fn rotate_consumes_presented_then_inserts_successor_and_replay_inserts_nothing() {
        let store = FakeGatekeeperStore::default();
        insert_refresh_token_family(&store, &family("fam"), &token("live", "fam")).unwrap();
        let now = Utc::now();

        assert_eq!(
            rotate_refresh_token(&store, "live", &token("successor", "fam"), now).unwrap(),
            RefreshTokenConsumeOutcome::Consumed,
        );
        assert_eq!(
            store
                .refresh_token_with_family_by_hash("live")
                .unwrap()
                .unwrap()
                .0
                .consumed_at,
            Some(now)
        );
        assert!(store
            .refresh_token_with_family_by_hash("successor")
            .unwrap()
            .is_some());

        assert_eq!(
            rotate_refresh_token(&store, "live", &token("successor-2", "fam"), now).unwrap(),
            RefreshTokenConsumeOutcome::Replayed,
        );
        assert!(store
            .refresh_token_with_family_by_hash("successor-2")
            .unwrap()
            .is_none());
    }

    #[test]
    fn consume_reports_consumed_then_replayed_then_not_found() {
        let store = FakeGatekeeperStore::default();
        insert_refresh_token_family(&store, &family("fam"), &token("live", "fam")).unwrap();
        let now = Utc::now();

        assert_eq!(
            consume_refresh_token(&store, "live", now).unwrap(),
            RefreshTokenConsumeOutcome::Consumed,
        );
        assert_eq!(
            consume_refresh_token(&store, "live", now).unwrap(),
            RefreshTokenConsumeOutcome::Replayed,
        );
        assert_eq!(
            consume_refresh_token(&store, "never-issued", now).unwrap(),
            RefreshTokenConsumeOutcome::NotFound,
        );
    }
}
