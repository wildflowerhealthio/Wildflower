//! The authenticated-caller extractor — the [`VerifiedClaims`] the
//! [`require_valid_session`](crate::http::middleware::require_valid_session)
//! layer verified and stashed in the request extensions. A handler takes
//! `CallerSession` when it needs the caller's own identity or scopes — logout's
//! self-revoke (the caller's `jti`/`exp`) and the consent approver clamp (the
//! caller's granted scopes) — instead of re-verifying the token.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;

use scopes_rust::Grant;

use crate::domain::token::VerifiedClaims;
use crate::http::errors;
use crate::http::scoped::grant_from_claims;
use crate::http::state::GatekeeperState;

/// The verified claims of the caller behind an `/access` request. Present because
/// [`require_valid_session`](crate::http::middleware::require_valid_session) ran
/// and inserted them; a handler reads them here rather than re-verifying.
pub(crate) struct CallerSession(pub(crate) VerifiedClaims);

impl CallerSession {
    /// The caller's granted scopes, parsed from their space-separated `scope`
    /// claim into a coverage-checkable [`Grant`] — the approver's authority used
    /// by the consent delegation clamp.
    pub(crate) fn granted_scopes(&self) -> Grant {
        grant_from_claims(&self.0)
    }
}

impl FromRequestParts<Arc<GatekeeperState>> for CallerSession {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &Arc<GatekeeperState>,
    ) -> Result<Self, Self::Rejection> {
        // Absence is a wiring bug (the authN layer didn't run), not a client
        // error — fail closed with a 500 rather than admit an unauthenticated
        // request.
        parts
            .extensions
            .get::<VerifiedClaims>()
            .cloned()
            .map(CallerSession)
            .ok_or_else(|| {
                errors::internal_error(
                    "caller session",
                    "VerifiedClaims missing from request extensions; require_valid_session must run before this handler",
                )
            })
    }
}
