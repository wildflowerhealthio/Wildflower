//! Token capability — the `wildflower/Token.d` capability behind
//! `POST /access/revocations`. It touches no store, only the [`Revocation`] port,
//! so it isn't generic; it holds the port handle lifted from the state.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::ports::Revocation;

/// The scope gating [`TokenRevoker`] — `wildflower/Token.d`. `Token` is broader
/// than `RefreshToken`: a `jti` denylist or a subject epoch bump kills live
/// access **and** refresh tokens.
pub(crate) fn token_revoker_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Token,
        Permission::DELETE,
    )]
}

/// Revoke issued tokens — `POST /access/revocations`.
pub(crate) struct TokenRevoker {
    revocation: Arc<dyn Revocation>,
}

impl TokenRevoker {
    /// Build the revoker over the revocation port lifted from the state.
    pub(crate) fn new(revocation: Arc<dyn Revocation>) -> Self {
        TokenRevoker { revocation }
    }

    /// Denylist a single token by `jti` until its own expiry.
    pub(crate) fn revoke_jti(
        &self,
        jti: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        self.revocation
            .revoke_jti(jti, expires_at, "admin")
            .map_err(|e| GatekeeperError::infrastructure("revoke_jti failed", e))
    }

    /// Bulk-revoke a subject's whole token cohort via an epoch bump to now.
    pub(crate) fn revoke_subject(&self, subject: &str) -> Result<(), GatekeeperError> {
        self.revocation
            .revoke_subject_as_of_now(subject)
            .map_err(|e| GatekeeperError::infrastructure("revoke_subject_as_of_now failed", e))
    }
}
