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
use crate::domain::{ClaimCodeTarget, IssuedClaimCode, TunnelError};
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
    /// Issue a claim code for `target`, from the OS's randomness (see
    /// [`ClaimCodesIssuer::issue`]). It runs between tunnel changes, so a
    /// preset code's tunnel cannot be deleted under it.
    ///
    /// # Errors
    ///
    /// See [`ClaimCodesIssuer::issue`].
    pub(crate) async fn issue(
        &self,
        target: ClaimCodeTarget,
    ) -> Result<IssuedClaimCode, TunnelError> {
        let issuer = Arc::clone(&self.issuer);
        let issued_target = target.clone();
        let issued = self
            .registry
            .while_unchanged(move || {
                // Panics only if the OS has no randomness to give.
                let mut rng = UnwrapErr(SysRng);
                issuer.issue(&issued_target, &mut rng, || {
                    unix_now()
                        .map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
                })
            })
            .await?;
        match target {
            ClaimCodeTarget::Preset { tunnel_name } => tracing::info!(
                target: IDENTIFYING,
                tunnel = %tunnel_name,
                expires_at = issued.expires_at,
                "claim code issued"
            ),
            ClaimCodeTarget::Open => tracing::info!(
                expires_at = issued.expires_at,
                "claim code issued for a new tunnel"
            ),
        }
        Ok(issued)
    }
}
