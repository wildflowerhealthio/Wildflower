//! The authenticated-caller extractor — the [`VerifiedClaims`] the
//! [`require_valid_session`](crate::http::middleware::require_valid_session)
//! layer verified and stashed in the request extensions. A handler takes
//! `CallerSession` when it needs the caller's own identity — logout's
//! self-revoke (the caller's `jti`/`exp`) — instead of re-verifying. Handlers
//! that need the caller's *scopes* go through a
//! [`Scoped<…>`](crate::http::capabilities::Scoped) capability instead, which
//! reads the same extension.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;

use crate::domain::token::VerifiedClaims;
use crate::http::errors;
use crate::http::state::GatekeeperState;

/// The verified claims of the caller behind an `/access` request. Present because
/// [`require_valid_session`](crate::http::middleware::require_valid_session) ran
/// and inserted them; a handler reads them here rather than re-verifying.
pub(crate) struct CallerSession(pub(crate) VerifiedClaims);

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
