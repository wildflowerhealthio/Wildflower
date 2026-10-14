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

/// Revoke issued tokens — `POST /authorization/revocations`.
pub(crate) struct TokenRevoker {
    revocation: Arc<dyn Revocation>,
    /// The Owner's client, whose tokens are revoked one at a time only.
    first_party_client_id: Arc<str>,
}

impl TokenRevoker {
    /// Build the revoker over the revocation port and the first-party
    /// `client_id`, both lifted from the state.
    pub(crate) fn new(revocation: Arc<dyn Revocation>, first_party_client_id: Arc<str>) -> Self {
        TokenRevoker {
            revocation,
            first_party_client_id,
        }
    }

    /// Denylist a single token by `jti` until its own expiry.
    pub(crate) fn revoke_jti(
        &self,
        jti: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.revocation
            .revoke_jti(jti, expires_at, "admin")
            .map_err(|e| AuthorizationServerError::infrastructure("revoke_jti failed", e))
    }

    /// Bulk-revoke a subject's whole token cohort via an epoch bump to now.
    ///
    /// # Errors
    ///
    /// The first-party client is the Owner's, and revoking its cohort would
    /// end every Owner session at once, so it is
    /// [`AuthorizationServerError::FirstPartyClientLocked`] and nothing is
    /// revoked; a single Owner token is revoked by its `jti` instead.
    pub(crate) fn revoke_subject(&self, subject: &str) -> Result<(), AuthorizationServerError> {
        if subject == &*self.first_party_client_id {
            return Err(AuthorizationServerError::FirstPartyClientLocked {
                client_id: subject.to_owned(),
            });
        }
        self.revocation
            .revoke_subject_as_of_now(subject)
            .map_err(|e| {
                AuthorizationServerError::infrastructure("revoke_subject_as_of_now failed", e)
            })
    }
}
