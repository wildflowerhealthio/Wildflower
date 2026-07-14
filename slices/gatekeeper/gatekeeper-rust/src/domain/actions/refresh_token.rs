//! Refresh-token-family actions over the [`GatekeeperStore`] port.

use chrono::{DateTime, Utc};

use crate::domain::error::GatekeeperError;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily};
use crate::domain::GatekeeperStore;

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

/// Resolve a presented token hash to its row plus owning family.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn refresh_token_with_family_by_hash(
    store: &impl GatekeeperStore,
    token_hash: &str,
) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
    store.refresh_token_with_family_by_hash(token_hash)
}

/// Rotate a refresh token: consume the presented token, and **only** if that
/// consume won (transitioned a live row) insert its successor. The consume is
/// itself atomic (its `consumed_at IS NULL` guard + existence probe run in the
/// store's own transaction), so exactly one concurrent redeemer sees `Consumed`
/// and inserts a successor; a `Replayed`/`NotFound` redeemer inserts nothing and
/// the family is untouched. No wrapping transaction is needed — the ordering
/// (consume before insert) means a failure of the second step leaves the
/// presented token spent but no successor, which the caller treats as a failed
/// rotation, never a usable extra token.
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
    let outcome = store.consume_refresh_token(presented_hash, now)?;
    if outcome == RefreshTokenConsumeOutcome::Consumed {
        store.insert_refresh_token(successor)?;
    }
    Ok(outcome)
}

/// End a single refresh-token family (reuse detection).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn expire_refresh_token_family(
    store: &impl GatekeeperStore,
    family_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.expire_refresh_token_family(family_id, now)
}

/// End every family minted from an authorization code (code-reuse detection).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn expire_refresh_token_families_for_authorization_code(
    store: &impl GatekeeperStore,
    authorization_code_hash: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.expire_refresh_token_families_for_authorization_code(authorization_code_hash, now)
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::super::test_fake::FakeGatekeeperStore;
    use super::*;

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

        // First rotation wins the consume and installs the successor.
        assert_eq!(
            rotate_refresh_token(&store, "live", &token("successor", "fam"), now).unwrap(),
            RefreshTokenConsumeOutcome::Consumed,
        );
        assert_eq!(
            store
                .refresh_token_by_hash("live")
                .unwrap()
                .unwrap()
                .consumed_at,
            Some(now)
        );
        assert!(store.refresh_token_by_hash("successor").unwrap().is_some());

        // A replay of the already-consumed token installs no further successor.
        assert_eq!(
            rotate_refresh_token(&store, "live", &token("successor-2", "fam"), now).unwrap(),
            RefreshTokenConsumeOutcome::Replayed,
        );
        assert!(store
            .refresh_token_by_hash("successor-2")
            .unwrap()
            .is_none());
    }
}
