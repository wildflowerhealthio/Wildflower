//! The [`LiveAccessCodesRedeemer`] binding — redeems an access code through
//! the concrete `SqliteTunnelStore` and serves the tunnel it creates through
//! the registry. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;

use super::state::{Change, TunnelRegistry};
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::AccessCodesRedeemer;
use crate::domain::{RedeemedAccessCode, TunnelError};
use crate::logging::IDENTIFYING;
use crate::site::signature::unix_now;

/// Redeem an access code — the state of `POST /access`. Not admin-gated:
/// the code is the credential.
#[derive(Clone)]
pub(crate) struct LiveAccessCodesRedeemer {
    redeemer: Arc<AccessCodesRedeemer<SqliteTunnelStore>>,
    registry: Arc<TunnelRegistry>,
}

impl LiveAccessCodesRedeemer {
    /// The redeemer over `registry`'s store, serving through it.
    pub(crate) fn new(registry: &Arc<TunnelRegistry>) -> Self {
        Self {
            redeemer: Arc::new(AccessCodesRedeemer::new(
                registry.store.clone(),
                registry.front.clone(),
            )),
            registry: Arc::clone(registry),
        }
    }

    /// Redeem the code `typed_code` spells, burning it, for a new tunnel for
    /// `email`, named `name` or, without one, two random words (see
    /// [`AccessCodesRedeemer::redeem`]), and serve it.
    ///
    /// # Errors
    ///
    /// See [`AccessCodesRedeemer::redeem`]. On an error nothing has changed.
    pub(crate) async fn redeem(
        &self,
        typed_code: String,
        email: String,
        name: Option<String>,
    ) -> Result<RedeemedAccessCode, TunnelError> {
        let (redeemer, undoer) = (Arc::clone(&self.redeemer), Arc::clone(&self.redeemer));
        let redeemed = self
            .registry
            .change(
                Change::Created,
                move || {
                    // Panics only if the OS has no randomness to give.
                    let mut rng = UnwrapErr(SysRng);
                    redeemer.redeem(&typed_code, &email, name.as_deref(), &mut rng, || {
                        unix_now()
                            .map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
                    })
                },
                move |redeemed| undoer.undo(redeemed),
                "tunnel stored for an access code but not served",
            )
            .await?;
        tracing::info!(
            target: IDENTIFYING,
            tunnel = %redeemed.stored.tunnel.name,
            "access code redeemed"
        );
        Ok(redeemed)
    }
}

#[cfg(test)]
mod tests {
    use rathole::{ConfigChange, ServerServiceChange};

    use super::*;
    use crate::config;
    use crate::domain::TunnelStore;
    use crate::live_bindings::LiveAccessCodesIssuer;
    use crate::test_support::{admin, registry};

    /// A redeemed code's tunnel is sent to rathole and routes at once;
    /// concurrent redeems of one code have exactly one winner.
    #[tokio::test]
    async fn an_issued_code_redeems_once_for_a_served_tunnel() {
        let (registry, mut fixture) = registry(None).await;
        let issuer: LiveAccessCodesIssuer = admin(&registry);
        let code = issuer.issue().await.unwrap().code.to_string();

        let redeemer = LiveAccessCodesRedeemer::new(&registry);
        let redeems = ["bob", "carol", "dave", "erin"].map(|name| {
            redeemer.redeem(
                code.clone(),
                format!("{name}@example.com"),
                Some(name.to_owned()),
            )
        });
        let results = futures_util::future::join_all(redeems).await;
        let won: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(won.len(), 1, "exactly one redeem wins");
        assert!(results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| *e == TunnelError::AccessCodeRejected));

        let stored = &won[0].stored;
        assert_eq!(
            registry.store.list_tunnels().unwrap(),
            std::slice::from_ref(stored)
        );
        assert_eq!(
            fixture.rathole.changes.recv().await,
            Some(ConfigChange::ServerChange(ServerServiceChange::Add(
                config::service(&stored.tunnel)
            )))
        );
        let host = format!("{}.relay.example.com", stored.tunnel.name);
        assert!(registry.router().resolve(&host).is_some());
    }

    /// A refused redeem leaves the store and what is served alone.
    #[tokio::test]
    async fn a_refused_redeem_changes_nothing() {
        let (registry, mut fixture) = registry(None).await;
        let issuer: LiveAccessCodesIssuer = admin(&registry);
        let code = issuer.issue().await.unwrap().code.to_string();
        let redeemer = LiveAccessCodesRedeemer::new(&registry);
        assert_eq!(
            redeemer
                .redeem(code, "bob".to_owned(), Some("bob".to_owned()))
                .await
                .unwrap_err(),
            TunnelError::InvalidEmail
        );
        assert!(registry.store.list_tunnels().unwrap().is_empty());
        assert!(fixture.rathole.changes.try_recv().is_err());
    }
}
