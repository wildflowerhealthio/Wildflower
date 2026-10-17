//! The [`LiveClaimCodesRedeemer`] binding — redeems a claim code through the
//! concrete `SqliteTunnelStore`. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use super::on_blocking;
use super::state::TunnelRegistry;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::ClaimCodesRedeemer;
use crate::domain::{Tunnel, TunnelError};
use crate::logging::IDENTIFYING;
use crate::site::signature::unix_now;

/// Redeem a claim code — the state of `POST /claim`. Not admin-gated: the
/// code is the credential.
#[derive(Clone)]
pub(crate) struct LiveClaimCodesRedeemer {
    redeemer: Arc<ClaimCodesRedeemer<SqliteTunnelStore>>,
}

impl LiveClaimCodesRedeemer {
    /// The redeemer over `registry`'s store.
    pub(crate) fn new(registry: &TunnelRegistry) -> Self {
        Self {
            redeemer: Arc::new(ClaimCodesRedeemer::new(registry.store.clone())),
        }
    }

    /// Redeem the code `typed_code` spells, burning it, for the tunnel it
    /// was issued for (see [`ClaimCodesRedeemer::redeem`]).
    ///
    /// # Errors
    ///
    /// See [`ClaimCodesRedeemer::redeem`].
    pub(crate) async fn redeem(&self, typed_code: String) -> Result<Tunnel, TunnelError> {
        let redeemer = Arc::clone(&self.redeemer);
        let tunnel = on_blocking(move || {
            redeemer.redeem(&typed_code, || {
                unix_now().map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
            })
        })
        .await?;
        tracing::info!(target: IDENTIFYING, tunnel = %tunnel.name, "claim code redeemed");
        Ok(tunnel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_bindings::{LiveClaimCodesIssuer, LiveTunnelsCreator, LiveTunnelsDeleter};
    use crate::test_support::{admin, registry};

    /// An issued code redeems for its tunnel's name and token; concurrent
    /// redeems of one code have exactly one winner.
    #[tokio::test]
    async fn an_issued_code_redeems_once_for_the_tunnel_s_token() {
        let (registry, _fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let mut created = Vec::new();
        for name in ["alice", "bob"] {
            let tunnel = creator
                .create(format!("{name}@example.com"), Some(name.to_owned()))
                .await
                .unwrap();
            created.push(tunnel.tunnel);
        }
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let issued = issuer.issue("bob".to_owned()).await.unwrap();

        let redeemer = LiveClaimCodesRedeemer::new(&registry);
        let code = issued.code.to_string();
        let redeems = (0..8).map(|_| redeemer.redeem(code.clone()));
        let results = futures_util::future::join_all(redeems).await;
        let won: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(won, [&created[1]], "exactly one redeem wins, for bob");
        assert!(results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| *e == TunnelError::ClaimCodeRejected));
    }

    #[tokio::test]
    async fn issuing_for_an_unknown_tunnel_is_not_found() {
        let (registry, _fixture) = registry(None).await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        assert_eq!(
            issuer.issue("nobody".to_owned()).await.unwrap_err(),
            TunnelError::NotFound
        );
    }

    #[tokio::test]
    async fn a_deleted_tunnel_s_codes_no_longer_redeem() {
        let (registry, _fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let issued = issuer.issue("bob".to_owned()).await.unwrap();
        let deleter: LiveTunnelsDeleter = admin(&registry);
        deleter.delete("bob".to_owned()).await.unwrap();
        let redeemer = LiveClaimCodesRedeemer::new(&registry);
        assert_eq!(
            redeemer.redeem(issued.code.to_string()).await.unwrap_err(),
            TunnelError::ClaimCodeRejected
        );
    }
}
