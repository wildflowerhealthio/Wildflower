//! The [`LiveClaimCodesRedeemer`] binding — redeems a claim code through the
//! concrete `SqliteTunnelStore` and serves the tunnel an open code creates
//! through the registry. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use wildflowerhealthio_rathole_settings::ClaimDetails;

use super::state::{Change, TunnelRegistry};
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::ClaimCodesRedeemer;
use crate::domain::{RedeemedClaimCode, TunnelError};
use crate::logging::IDENTIFYING;
use crate::site::signature::unix_now;

/// Redeem a claim code — the state of `POST /claim`. Not admin-gated: the
/// code is the credential.
#[derive(Clone)]
pub(crate) struct LiveClaimCodesRedeemer {
    redeemer: Arc<ClaimCodesRedeemer<SqliteTunnelStore>>,
    registry: Arc<TunnelRegistry>,
}

impl LiveClaimCodesRedeemer {
    /// The redeemer over `registry`'s store, serving through it.
    pub(crate) fn new(registry: &Arc<TunnelRegistry>) -> Self {
        Self {
            redeemer: Arc::new(ClaimCodesRedeemer::new(
                registry.store.clone(),
                registry.front.clone(),
            )),
            registry: Arc::clone(registry),
        }
    }

    /// Redeem the code `typed_code` spells, burning it, for the tunnel it
    /// names or, with `details`, for a new tunnel, which is then served (see
    /// [`ClaimCodesRedeemer::redeem`]). It runs as a tunnel change, so a
    /// tunnel it names cannot be deleted under it.
    ///
    /// # Errors
    ///
    /// See [`ClaimCodesRedeemer::redeem`]. On an error nothing has changed.
    pub(crate) async fn redeem(
        &self,
        typed_code: String,
        details: Option<ClaimDetails>,
    ) -> Result<RedeemedClaimCode, TunnelError> {
        let (redeemer, undoer) = (Arc::clone(&self.redeemer), Arc::clone(&self.redeemer));
        let redeemed = self
            .registry
            .change(
                Change::Created,
                move || {
                    // Panics only if the OS has no randomness to give.
                    let mut rng = UnwrapErr(SysRng);
                    redeemer.redeem(&typed_code, details.as_ref(), &mut rng, || {
                        unix_now()
                            .map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
                    })
                },
                move |redeemed| undoer.undo(redeemed),
                "tunnel stored for a claim code but not served",
            )
            .await?;
        tracing::info!(
            target: IDENTIFYING,
            tunnel = %redeemed.tunnel().name,
            "claim code redeemed"
        );
        Ok(redeemed)
    }
}

#[cfg(test)]
mod tests {
    use rathole::{ConfigChange, ServerServiceChange};

    use super::*;
    use crate::config;
    use crate::domain::{ClaimCodeTarget, TunnelStore};
    use crate::live_bindings::{LiveClaimCodesIssuer, LiveTunnelsCreator, LiveTunnelsDeleter};
    use crate::test_support::{admin, registry};

    fn preset(tunnel_name: &str) -> ClaimCodeTarget {
        ClaimCodeTarget::Preset {
            tunnel_name: tunnel_name.to_owned(),
        }
    }

    /// An issued preset code redeems for its tunnel's name and token;
    /// concurrent redeems of one code have exactly one winner.
    #[tokio::test]
    async fn an_issued_preset_code_redeems_once_for_the_tunnel_s_token() {
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
        let issued = issuer.issue(preset("bob")).await.unwrap();

        let redeemer = LiveClaimCodesRedeemer::new(&registry);
        let code = issued.code.to_string();
        let redeems = (0..8).map(|_| redeemer.redeem(code.clone(), None));
        let results = futures_util::future::join_all(redeems).await;
        let won: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(
            won,
            [&RedeemedClaimCode::Preset(created[1].clone())],
            "exactly one redeem wins, for bob"
        );
        assert!(results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| *e == TunnelError::ClaimCodeRejected));
    }

    /// A redeemed open code's tunnel is sent to rathole and routes at once;
    /// concurrent redeems of one code have exactly one winner.
    #[tokio::test]
    async fn an_issued_open_code_redeems_once_for_a_served_tunnel() {
        let (registry, mut fixture) = registry(None).await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let code = issuer
            .issue(ClaimCodeTarget::Open)
            .await
            .unwrap()
            .code
            .to_string();

        let redeemer = LiveClaimCodesRedeemer::new(&registry);
        let redeems = ["bob", "carol", "dave", "erin"].map(|name| {
            redeemer.redeem(
                code.clone(),
                Some(ClaimDetails {
                    email: format!("{name}@example.com"),
                    tunnel_name: Some(name.to_owned()),
                }),
            )
        });
        let results = futures_util::future::join_all(redeems).await;
        let won: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(won.len(), 1, "exactly one redeem wins");
        assert!(results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| *e == TunnelError::ClaimCodeRejected));

        let RedeemedClaimCode::Open { stored, .. } = won[0] else {
            panic!("redeemed {:?}", won[0]);
        };
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

    /// A refused redeem, and a preset code's redeem, leave what is served
    /// alone.
    #[tokio::test]
    async fn only_an_open_code_changes_what_is_served() {
        let (registry, mut fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        creator
            .create("alice@example.com".to_owned(), Some("alice".to_owned()))
            .await
            .unwrap();
        fixture.rathole.changes.recv().await.unwrap();
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let open = issuer.issue(ClaimCodeTarget::Open).await.unwrap().code;
        let preset_code = issuer.issue(preset("alice")).await.unwrap().code;
        let redeemer = LiveClaimCodesRedeemer::new(&registry);
        assert_eq!(
            redeemer
                .redeem(
                    open.to_string(),
                    Some(ClaimDetails {
                        email: "bob".to_owned(),
                        tunnel_name: Some("bob".to_owned()),
                    }),
                )
                .await
                .unwrap_err(),
            TunnelError::InvalidEmail
        );
        redeemer
            .redeem(preset_code.to_string(), None)
            .await
            .unwrap();
        assert_eq!(registry.store.list_tunnels().unwrap().len(), 1);
        assert!(fixture.rathole.changes.try_recv().is_err());
    }

    #[tokio::test]
    async fn issuing_for_an_unknown_tunnel_is_not_found() {
        let (registry, _fixture) = registry(None).await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        assert_eq!(
            issuer.issue(preset("nobody")).await.unwrap_err(),
            TunnelError::NotFound
        );
    }

    #[tokio::test]
    async fn a_deleted_tunnel_s_code_no_longer_redeems() {
        let (registry, _fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let issued = issuer.issue(preset("bob")).await.unwrap();
        let deleter: LiveTunnelsDeleter = admin(&registry);
        deleter.delete("bob".to_owned()).await.unwrap();
        let redeemer = LiveClaimCodesRedeemer::new(&registry);
        assert_eq!(
            redeemer
                .redeem(issued.code.to_string(), None)
                .await
                .unwrap_err(),
            TunnelError::ClaimCodeRejected
        );
    }
}
