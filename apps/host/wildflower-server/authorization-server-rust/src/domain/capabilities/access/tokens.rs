//! Token capability — the `wildflower/Token.d` capability behind
//! `POST /authorization/revocations`. It touches no store, only the [`Revocation`] port,
//! so it isn't generic; it holds the port handle lifted from the state.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

use crate::domain::authorization_server_error::AuthorizationServerError;
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

/// Revoke issued tokens — `POST /authorization/revocations`: one token by its
/// `jti`, or every token of a subject at once. The route takes exactly one of
/// the two per request.
pub(crate) struct TokenRevoker {
    /// The revocation store holding the `jti` denylist and the per-subject
    /// epochs the token verifier checks.
    revocation: Arc<dyn Revocation>,
}

impl TokenRevoker {
    /// Build the revoker over the revocation port lifted from the state.
    pub(crate) fn new(revocation: Arc<dyn Revocation>) -> Self {
        TokenRevoker { revocation }
    }

    /// Denylist a single token by `jti` until its own expiry, tagged with the
    /// reason `admin`. The caller passes the token's expiry so the denylist row
    /// can be swept once the token would have expired anyway.
    pub(crate) fn revoke_jti(
        &self,
        jti: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.revocation
            .revoke_jti(jti, expires_at, "admin")
            .map_err(|e| AuthorizationServerError::infrastructure("revoke_jti failed", e))
    }

    /// Bulk-revoke a subject's whole token cohort via an epoch bump to now. A
    /// token's subject is its client's `client_id`, so this signs a client out
    /// everywhere.
    pub(crate) fn revoke_subject(&self, subject: &str) -> Result<(), AuthorizationServerError> {
        self.revocation
            .revoke_subject_as_of_now(subject)
            .map_err(|e| {
                AuthorizationServerError::infrastructure("revoke_subject_as_of_now failed", e)
            })
    }
}
