//! Token facade — the `wildflower/Token.d` capability behind
//! `POST /access/revocations`.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use scopes_rust::{Grant, Permission, Scope, WildflowerResource};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::scoped::GatedService;
use crate::http::state::GatekeeperState;

/// Revoke issued tokens — `POST /access/revocations`. The `Token` resource is
/// broader than `RefreshToken`: a `jti` denylist or a subject epoch bump kills
/// live access **and** refresh tokens, so the capability is `Token.d`.
pub(crate) struct TokenRevoker {
    state: Arc<GatekeeperState>,
}

impl GatedService for TokenRevoker {
    type State = Arc<GatekeeperState>;
    type Claims = crate::domain::token::VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        vec![Scope::wildflower(
            WildflowerResource::Token,
            Permission::DELETE,
        )]
    }

    fn build(state: Arc<GatekeeperState>, _granted: &Grant) -> Self {
        TokenRevoker { state }
    }
}

impl TokenRevoker {
    /// Denylist a single token by `jti` until its own expiry.
    pub(crate) fn revoke_jti(
        &self,
        jti: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        self.state
            .revocation_store
            .revoke_jti(jti, expires_at, "admin")
            .map_err(|e| GatekeeperError::infrastructure("revoke_jti failed", e))
    }

    /// Bulk-revoke a subject's whole token cohort via an epoch bump to now.
    pub(crate) fn revoke_subject(&self, subject: &str) -> Result<(), GatekeeperError> {
        self.state
            .revocation_store
            .revoke_subject_as_of_now(subject)
            .map_err(|e| GatekeeperError::infrastructure("revoke_subject_as_of_now failed", e))
    }
}
