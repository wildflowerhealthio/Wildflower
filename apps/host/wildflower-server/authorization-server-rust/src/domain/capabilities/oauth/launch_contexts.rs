//! [`LaunchContexts`] — the SMART App Launch contexts this server hands out:
//! minted in-process when an app is launched, consumed single-use by the
//! `/oauth/authorize` request that presents the `launch` value. The authorization server
//! owns the `launch_contexts` table; every other slice reaches it through the
//! public mint-only [`LaunchContextMinter`](crate::LaunchContextMinter) binding.

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::launch_context::LaunchContext;
use crate::domain::{GrantStore, GrantTx};

/// Mint and consume launch contexts. A borrowed view over the store, like the
/// writers, so a flow capability holding the store can consume through it.
pub(crate) struct LaunchContexts<'a, S: GrantStore> {
    store: &'a S,
}

impl<'a, S: GrantStore> LaunchContexts<'a, S> {
    /// The launch contexts in `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        LaunchContexts { store }
    }

    /// Persist a fresh launch context `nonce` for `client_id`, binding no
    /// patient and expiring
    /// [`LAUNCH_CONTEXT_TTL`](crate::domain::launch_context::LAUNCH_CONTEXT_TTL)
    /// after `now`, and return it. Contexts already expired at `now` are pruned
    /// in the same transaction. The caller generates `nonce` (a CSPRNG opaque
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
    /// same transaction, and return it.
    fn insert_and_prune_expired(
        &self,
        launch_context: LaunchContext,
        now: DateTime<Utc>,
    ) -> Result<LaunchContext, AuthorizationServerError> {
        self.store.transaction(|tx| {
            tx.delete_launch_contexts_expired_by(now)?;
            tx.insert_launch_context(&launch_context)
        })?;
        Ok(launch_context)
    }

    /// Consume the launch `nonce` for `client_id` at `now`: the context, now
    /// stamped consumed, iff it was minted for `client_id` or for any client
    /// and is unconsumed and unexpired; otherwise `None` and nothing changes. A
    /// context presented by the wrong client therefore stays consumable by its
    /// own.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn consume(
        &self,
        nonce: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<LaunchContext>, AuthorizationServerError> {
        self.store
            .with_connection(|tx| tx.consume_launch_context(nonce, client_id, now))
    }

    /// Whether `nonce` names a launch `client_id` may consume that is spent:
    /// already consumed, or expired at `now`. A launch that was never minted,
    /// one minted for another client, and one pruned since it expired are not
    /// spent but unknown. `/oauth/authorize` asks this once a consume found
    /// nothing, to tell the user to launch again rather than refuse the app.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn is_spent_for(
        &self,
        nonce: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let launch_context = self
            .store
            .with_connection(|tx| tx.launch_context_by_nonce(nonce))?;
        Ok(launch_context.is_some_and(|launch_context| {
            launch_context.admits_client(client_id)
                && (launch_context.consumed_at.is_some() || launch_context.expires_at <= now)
        }))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::launch_context::LAUNCH_CONTEXT_TTL;
    use crate::domain::test_fake::FakeGrantStore;

    /// A minted context is unbound to any patient, expires after the TTL, and
    /// is consumed once by its own client.
    #[test]
    fn a_minted_context_is_consumed_once_by_its_client() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::over(&store);
        let now = Utc::now();
        let minted = launch_contexts
            .mint("app", "nonce-1".to_owned(), now)
            .expect("mint");
        assert_eq!(minted.client_id(), Some("app"));
        assert_eq!(minted.patient(), None);
        assert_eq!(minted.expires_at, now + LAUNCH_CONTEXT_TTL);

        assert_eq!(
            launch_contexts
                .consume("nonce-1", "other-app", now)
                .unwrap(),
            None,
            "another client can't consume it"
        );
        let consumed = launch_contexts
            .consume("nonce-1", "app", now)
            .unwrap()
            .expect("its own client consumes it");
        assert_eq!(consumed.consumed_at, Some(now));
        assert_eq!(
            launch_contexts.consume("nonce-1", "app", now).unwrap(),
            None,
            "a replay is refused"
        );
    }

    /// A context minted for any client binds no patient and is consumed once,
    /// by whichever client presents it first.
    #[test]
    fn a_context_for_any_client_is_consumed_once_by_any_client() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::over(&store);
        let now = Utc::now();
        let minted = launch_contexts
            .mint_for_any_client("nonce-1".to_owned(), now)
            .expect("mint");
        assert_eq!(minted.client_id(), None);
        assert_eq!(minted.patient(), None);
        assert_eq!(minted.expires_at, now + LAUNCH_CONTEXT_TTL);

        let consumed = launch_contexts
            .consume("nonce-1", "other-app", now)
            .unwrap()
            .expect("any client consumes it");
        assert_eq!(consumed.consumed_at, Some(now));
        assert_eq!(
            launch_contexts.consume("nonce-1", "app", now).unwrap(),
            None,
            "a second client is refused"
        );
    }

    /// A consumed launch and an expired one are spent for the client they
    /// admit; a live one, one for another client, and a forged one are not.
    #[test]
    fn a_consumed_or_expired_launch_is_spent_for_its_client() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::over(&store);
        let now = Utc::now();
        launch_contexts
            .mint("app", "consumed".to_owned(), now)
            .expect("mint consumed");
        launch_contexts
            .mint_for_any_client("consumed-any".to_owned(), now)
            .expect("mint consumed for any client");
        launch_contexts
            .mint("app", "live".to_owned(), now)
            .expect("mint live");
        // Minted last: a mint at `now` would prune it.
        launch_contexts
            .mint("app", "expired".to_owned(), now - LAUNCH_CONTEXT_TTL)
            .expect("mint expired");
        launch_contexts
            .consume("consumed", "app", now)
            .unwrap()
            .expect("consumed");
        launch_contexts
            .consume("consumed-any", "other-app", now)
            .unwrap()
            .expect("consumed by another client");
        let is_spent = |nonce: &str, client_id: &str| {
            launch_contexts
                .is_spent_for(nonce, client_id, now)
                .expect("read")
        };
        assert!(is_spent("expired", "app"));
        assert!(is_spent("consumed", "app"));
        assert!(is_spent("consumed-any", "app"));
        assert!(!is_spent("live", "app"));
        assert!(!is_spent("consumed", "other-app"), "for another client");
        assert!(!is_spent("forged", "app"));
    }

    /// Minting prunes the contexts already expired, and keeps live ones.
    #[test]
    fn minting_prunes_expired_contexts() {
        let store = FakeGrantStore::default();
        let launch_contexts = LaunchContexts::over(&store);
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
            store
                .with_connection(|tx| tx.delete_launch_contexts_expired_by(now))
                .unwrap(),
            0,
            "the last mint already pruned the expired context"
        );
        assert!(launch_contexts
            .consume("recent", "app", now)
            .unwrap()
            .is_some());
        assert!(launch_contexts
            .consume("old", "app", now)
            .unwrap()
            .is_none());
    }
}
