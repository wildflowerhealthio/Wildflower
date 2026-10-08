//! [`LaunchContexts`] — the SMART App Launch contexts this server hands out:
//! minted in-process when an app is launched, consumed single-use by the
//! `/oauth/authorize` request that presents the `launch` value. The gatekeeper
//! owns the `launch_contexts` table; every other slice reaches it through the
//! public mint-only [`LaunchContextMinter`](crate::LaunchContextMinter) binding.

use chrono::{DateTime, Utc};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::launch_context::LaunchContext;
use crate::domain::{GatekeeperStore, GatekeeperTx};

/// Mint and consume launch contexts. A borrowed view over the store, like the
/// writers, so a flow capability holding the store can consume through it.
pub(crate) struct LaunchContexts<'a, S: GatekeeperStore> {
    store: &'a S,
}

impl<'a, S: GatekeeperStore> LaunchContexts<'a, S> {
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
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn mint(
        &self,
        client_id: &str,
        nonce: String,
        now: DateTime<Utc>,
    ) -> Result<LaunchContext, GatekeeperError> {
        let launch_context = LaunchContext::new(nonce, client_id, now);
        self.store.transaction(|tx| {
            tx.delete_launch_contexts_expired_by(now)?;
            tx.insert_launch_context(&launch_context)
        })?;
        Ok(launch_context)
    }

    /// Consume the launch `nonce` for `client_id` at `now`: the context, now
    /// stamped consumed, iff it was minted for `client_id` and is unconsumed
    /// and unexpired; otherwise `None` and nothing changes. A context presented
    /// by the wrong client therefore stays consumable by its own.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn consume(
        &self,
        nonce: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<LaunchContext>, GatekeeperError> {
        self.store
            .with_connection(|tx| tx.consume_launch_context(nonce, client_id, now))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::launch_context::LAUNCH_CONTEXT_TTL;
    use crate::domain::test_fake::FakeGatekeeperStore;

    /// A minted context is unbound to any patient, expires after the TTL, and
    /// is consumed once by its own client.
    #[test]
    fn a_minted_context_is_consumed_once_by_its_client() {
        let store = FakeGatekeeperStore::default();
        let launch_contexts = LaunchContexts::over(&store);
        let now = Utc::now();
        let minted = launch_contexts
            .mint("app", "nonce-1".to_owned(), now)
            .expect("mint");
        assert_eq!(minted.client_id, "app");
        assert_eq!(minted.patient, None);
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

    /// Minting prunes the contexts already expired, and keeps live ones.
    #[test]
    fn minting_prunes_expired_contexts() {
        let store = FakeGatekeeperStore::default();
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
