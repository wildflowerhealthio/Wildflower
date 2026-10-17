//! The [`LiveClaimCodesIssuer`] binding — issues a claim code through the
//! concrete `SqliteTunnelStore`, between tunnel changes. See the
//! [module docs](super) for the binding seam.

use std::sync::Arc;

use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;

use super::state::TunnelRegistry;
use super::AdminCapability;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::ClaimCodesIssuer;
use crate::domain::{IssuedClaimCode, TunnelError};
use crate::logging::IDENTIFYING;
use crate::site::signature::unix_now;

/// Issue a claim code — `Admin<LiveClaimCodesIssuer>` in the issue handler.
pub(crate) struct LiveClaimCodesIssuer {
    issuer: Arc<ClaimCodesIssuer<SqliteTunnelStore>>,
    registry: Arc<TunnelRegistry>,
}

impl AdminCapability for LiveClaimCodesIssuer {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            issuer: Arc::new(ClaimCodesIssuer::new(
                state.store.clone(),
                state.claim_code_ttl,
            )),
            registry: state,
        }
    }
}

impl LiveClaimCodesIssuer {
    /// Issue a claim code for the tunnel named `tunnel_name`, from the OS's
    /// randomness (see [`ClaimCodesIssuer::issue`]). It runs between tunnel
    /// changes, so the tunnel cannot be deleted under it.
    ///
    /// # Errors
    ///
    /// See [`ClaimCodesIssuer::issue`].
    pub(crate) async fn issue(&self, tunnel_name: String) -> Result<IssuedClaimCode, TunnelError> {
        let issuer = Arc::clone(&self.issuer);
        let name = tunnel_name.clone();
        let issued = self
            .registry
            .while_unchanged(move || {
                // Panics only if the OS has no randomness to give.
                let mut rng = UnwrapErr(SysRng);
                issuer.issue(&tunnel_name, &mut rng, || {
                    unix_now()
                        .map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
                })
            })
            .await?;
        tracing::info!(
            target: IDENTIFYING,
            tunnel = %name,
            expires_at = issued.expires_at,
            "claim code issued"
        );
        Ok(issued)
    }
}
