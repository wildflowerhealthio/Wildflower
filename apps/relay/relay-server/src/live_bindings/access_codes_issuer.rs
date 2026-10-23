//! The [`LiveAccessCodesIssuer`] binding — issues an access code through the
//! concrete `SqliteTunnelStore`. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;

use super::on_blocking;
use super::state::TunnelRegistry;
use super::AdminCapability;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::AccessCodesIssuer;
use crate::domain::{IssuedClaimCode, TunnelError};
use crate::logging::IDENTIFYING;
use crate::site::signature::unix_now;

/// Issue an access code — `Admin<LiveAccessCodesIssuer>` in the issue
/// handler.
pub(crate) struct LiveAccessCodesIssuer {
    issuer: Arc<AccessCodesIssuer<SqliteTunnelStore>>,
}

impl AdminCapability for LiveAccessCodesIssuer {
    type State = Arc<TunnelRegistry>;

    fn build(state: Arc<TunnelRegistry>) -> Self {
        Self {
            issuer: Arc::new(AccessCodesIssuer::new(
                state.store.clone(),
                state.claim_code_ttl,
            )),
        }
    }
}

impl LiveAccessCodesIssuer {
    /// Issue an access code from the OS's randomness (see
    /// [`AccessCodesIssuer::issue`]). It names no tunnel, so it needs no
    /// guard against tunnel changes.
    ///
    /// # Errors
    ///
    /// See [`AccessCodesIssuer::issue`].
    pub(crate) async fn issue(&self) -> Result<IssuedClaimCode, TunnelError> {
        let issuer = Arc::clone(&self.issuer);
        let issued = on_blocking(move || {
            // Panics only if the OS has no randomness to give.
            let mut rng = UnwrapErr(SysRng);
            issuer.issue(&mut rng, || {
                unix_now().map_err(|e| TunnelError::infrastructure("reading the clock failed", e))
            })
        })
        .await?;
        tracing::info!(
            target: IDENTIFYING,
            expires_at = issued.expires_at,
            "access code issued"
        );
        Ok(issued)
    }
}
