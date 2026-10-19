//! [`LaunchContexts`] — the SMART App Launch contexts this server hands out:
//! minted in-process when an app is launched, consumed single-use by the
//! `/oauth/authorize` request that presents the `launch` value. The authorization server
//! owns the `launch_contexts` table; every other slice reaches it through the
//! public mint-only [`LaunchContextMinter`](crate::LaunchContextMinter) binding.

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::LaunchContextsTx;
use crate::domain::launch_context::{LaunchContext, LaunchRefusal};
use crate::domain::GrantStore;

/// Mint launch contexts. Generic over the store port so it's unit-testable
/// against the fake; the [`LaunchContextMinter`](crate::LaunchContextMinter)
/// binding instantiates it over the concrete `SqliteGrantStore`.
#[derive(Clone)]
pub(crate) struct LaunchContexts<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> LaunchContexts<S> {
    /// Build it over a store handle.
    pub(crate) fn new(store: S) -> Self {
        LaunchContexts { store }
    }

    /// Persist a fresh launch context `nonce` for `client_id`, binding no
    /// patient and expiring
    /// [`LAUNCH_CONTEXT_TTL`](crate::domain::launch_context::LAUNCH_CONTEXT_TTL)
    /// after `now`, and return it. Contexts already expired at `now` are pruned
    /// in the same scope. The caller generates `nonce` (a CSPRNG opaque
    /// token) so tests can inject a known value.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn mint(
        &self,
        client_id: &str,
        nonce: String,
        now: DateTime<Utc>,
    ) -> Result<LaunchContext, AuthorizationServerError> {
        self.insert_and_prune_expired(LaunchContext::for_client(nonce, client_id, None, now), now)
    }

    /// Persist a fresh launch context `nonce` that any client may consume, and
    /// return it. Otherwise as [`LaunchContexts::mint`]: no patient, the same
    /// expiry, the same prune.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn mint_for_any_client(
        &self,
        nonce: String,
        now: DateTime<Utc>,
    ) -> Result<LaunchContext, AuthorizationServerError> {
        self.insert_and_prune_expired(LaunchContext::for_any_client(nonce, now), now)
    }

    /// Insert `launch_context`, deleting the contexts expired at `now` in the
    /// same scope, and return it.
    fn insert_and_prune_expired(
        &self,
        launch_context: LaunchContext,
        now: DateTime<Utc>,
    ) -> Result<LaunchContext, AuthorizationServerError> {
        self.store.write(|tx| {
            tx.delete_launch_contexts_expired_by(now)?;
            tx.insert_launch_context(&launch_context)
        })?;
        Ok(launch_context)
    }
}

/// Consume the launch `nonce` for `client_id` at `now`, in the caller's write
/// scope `tx`: the context, now stamped consumed, iff it was minted for
/// `client_id` or for any client and is unconsumed and unexpired. Otherwise
/// nothing changes, and the [`LaunchRefusal`] says why. A context presented
/// by the wrong client therefore stays consumable by its own.
///
/// The consume is one conditional update, so of two racing consumes exactly
/// one wins. Only when it finds nothing is the row read back to classify the
/// refusal, checking in this order: no row is
/// [`Unknown`](LaunchRefusal::Unknown), another client's launch is
/// [`ForAnotherApp`](LaunchRefusal::ForAnotherApp) (so its state is never
/// told), then [`AlreadyUsed`](LaunchRefusal::AlreadyUsed), then
/// [`Expired`](LaunchRefusal::Expired). A launch pruned after expiring is
/// gone, so it reads as unknown.
///
/// # Errors
///
/// [`AuthorizationServerError::Infrastructure`] on a store failure.
pub(crate) fn consume_launch(
    tx: &mut impl LaunchContextsTx,
    nonce: &str,
    client_id: &str,
    now: DateTime<Utc>,
) -> Result<Result<LaunchContext, LaunchRefusal>, AuthorizationServerError> {
    if let Some(consumed) = tx.consume_launch_context(nonce, client_id, now)? {
        return Ok(Ok(consumed));
    }
    let refusal = match tx.launch_context_by_nonce(nonce)? {
        None => LaunchRefusal::Unknown,
        Some(stored) if !stored.admits_client(client_id) => LaunchRefusal::ForAnotherApp,
        Some(stored) if stored.consumed_at.is_some() => LaunchRefusal::AlreadyUsed,
        Some(stored) if stored.expires_at <= now => LaunchRefusal::Expired,
        Some(_) => {
            return Err(AuthorizationServerError::infrastructure(
                "consume_launch_context",
                "refused a launch that is admitted, unconsumed and unexpired",
            ))
        }
    };
    Ok(Err(refusal))
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use super::*;
    use crate::domain::launch_context::LAUNCH_CONTEXT_TTL;
    use crate::domain::test_fake::FakeGrantStore;

    /// Consume `nonce` for `client_id` at `now` in `launch_contexts`' store, as
    /// `/oauth/authorize` does inside its scope.
    fn consume(
        launch_contexts: &LaunchContexts<FakeGrantStore>,
        nonce: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Result<LaunchContext, LaunchRefusal>, AuthorizationServerError> {
        launch_contexts
            .store
            .write(|tx| consume_launch(tx, nonce, client_id, now))
    }

    /// A minted context is unbound to any patient, expires after the TTL, and
    /// is consumed once by its own client.
    #[test]
    fn a_minted_context_is_consumed_once_by_its_client() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::new(store);
        let now = Utc::now();
        let minted = launch_contexts
            .mint("app", "nonce-1".to_owned(), now)
            .expect("mint");
        assert_eq!(minted.client_id(), Some("app"));
        assert_eq!(minted.patient(), None);
        assert_eq!(minted.expires_at, now + LAUNCH_CONTEXT_TTL);

        assert_eq!(
            consume(&launch_contexts, "nonce-1", "other-app", now).unwrap(),
            Err(LaunchRefusal::ForAnotherApp),
            "another client can't consume it"
        );
        let consumed = consume(&launch_contexts, "nonce-1", "app", now)
            .unwrap()
            .expect("its own client consumes it");
        assert_eq!(consumed.consumed_at, Some(now));
        assert_eq!(
            consume(&launch_contexts, "nonce-1", "app", now).unwrap(),
            Err(LaunchRefusal::AlreadyUsed),
            "a replay is refused"
        );
    }

    /// A context minted for any client binds no patient and is consumed once,
    /// by whichever client presents it first.
    #[test]
    fn a_context_for_any_client_is_consumed_once_by_any_client() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::new(store);
        let now = Utc::now();
        let minted = launch_contexts
            .mint_for_any_client("nonce-1".to_owned(), now)
            .expect("mint");
        assert_eq!(minted.client_id(), None);
        assert_eq!(minted.patient(), None);
        assert_eq!(minted.expires_at, now + LAUNCH_CONTEXT_TTL);

        let consumed = consume(&launch_contexts, "nonce-1", "other-app", now)
            .unwrap()
            .expect("any client consumes it");
        assert_eq!(consumed.consumed_at, Some(now));
        assert_eq!(
            consume(&launch_contexts, "nonce-1", "app", now).unwrap(),
            Err(LaunchRefusal::AlreadyUsed),
            "a second client is refused"
        );
    }

    /// Minting prunes the contexts already expired, and keeps live ones.
    #[test]
    fn minting_prunes_expired_contexts() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::new(store);
        let now = Utc::now();
        launch_contexts
            .mint("app", "old".to_owned(), now - LAUNCH_CONTEXT_TTL)
            .expect("mint old");
        launch_contexts
            .mint("app", "recent".to_owned(), now - Duration::minutes(1))
            .expect("mint recent");
        launch_contexts
            .mint("app", "new".to_owned(), now)
            .expect("mint new");
        assert_eq!(
            launch_contexts
                .store
                .write(|tx| tx.delete_launch_contexts_expired_by(now))
                .unwrap(),
            0,
            "the last mint already pruned the expired context"
        );
        assert!(consume(&launch_contexts, "recent", "app", now)
            .unwrap()
            .is_ok());
        assert_eq!(
            consume(&launch_contexts, "old", "app", now).unwrap(),
            Err(LaunchRefusal::Unknown),
            "a pruned launch reads as unknown"
        );
    }

    /// Each refusal is told apart, checking another client's launch first:
    /// its state is never told, and it stays consumable by its own client.
    #[test]
    fn a_refused_consume_says_why() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::new(store);
        let now = Utc::now();
        let expired_at = now + LAUNCH_CONTEXT_TTL;
        launch_contexts
            .mint("app", "live".to_owned(), now)
            .expect("mint live");
        launch_contexts
            .mint("app", "used".to_owned(), now)
            .expect("mint used");
        consume(&launch_contexts, "used", "app", now)
            .unwrap()
            .expect("consume used");

        for (nonce, client_id, at, refusal) in [
            ("forged", "app", now, LaunchRefusal::Unknown),
            ("live", "other-app", now, LaunchRefusal::ForAnotherApp),
            ("used", "other-app", now, LaunchRefusal::ForAnotherApp),
            (
                "live",
                "other-app",
                expired_at,
                LaunchRefusal::ForAnotherApp,
            ),
            ("used", "app", now, LaunchRefusal::AlreadyUsed),
            ("live", "app", expired_at, LaunchRefusal::Expired),
        ] {
            assert_eq!(
                consume(&launch_contexts, nonce, client_id, at).unwrap(),
                Err(refusal),
                "{nonce} by {client_id}"
            );
        }
        assert!(
            consume(&launch_contexts, "live", "app", now)
                .unwrap()
                .is_ok(),
            "the refusals left the live launch consumable by its own client"
        );
    }
}
