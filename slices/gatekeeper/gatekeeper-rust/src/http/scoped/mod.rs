//! Scope-gated service extractors — the authorization (authZ) half of the
//! `/access` surface, and the mechanism that makes a forgotten permission check
//! structurally hard rather than merely a discipline.
//!
//! The [`require_valid_session`](crate::http::middleware::require_valid_session)
//! layer proves *who* the caller is (authN, `401` on failure) and stashes the
//! [`VerifiedClaims`] in the request extensions. Each `/access` handler then
//! acquires the store **only** through a [`Scoped<F>`] extractor: it reads those
//! claims, builds a coverage-checkable [`Grant`], and hands back the narrow
//! service facade `F` **only if** the token covers `F`'s required scope —
//! otherwise a `403` naming the missing scopes. Because the facade is the sole
//! door to the store for these handlers (see [`facades`]), a handler that skips
//! the scope check simply has no way to reach any data: the check isn't a step
//! you remember to add, it's the price of admission to the store.
//!
//! The (resource, permission) → required-[`Scope`] mapping lives in one place —
//! each facade's [`GatedService::required_scopes`] impl in [`facades`] — and the
//! same set is surfaced as [`facades::grantable_admin_scopes`], the admin half
//! of the grantable-scope vocabulary the consent surfaces offer. Enforced and
//! grantable can't drift because they read the same registry.

pub(crate) mod facades;

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;

use scopes_rust::{Grant, Scope};

use crate::domain::token::VerifiedClaims;
use crate::http::errors;
use crate::http::state::GatekeeperState;

/// A narrow, scope-gated view of the gatekeeper store. Each implementor is a
/// service facade exposing just the operations one `wildflower/<Resource>.<perm>`
/// scope authorizes; the [`Scoped`] extractor is the only constructor, and it
/// runs [`required_scopes`](GatedService::required_scopes) as a gate first.
pub(crate) trait GatedService: Sized {
    /// The scope(s) the caller's token must cover — **all** of them — to obtain
    /// this service. Almost every service requires exactly one scope; returning
    /// several expresses their conjunction (the fail-closed owner default, which
    /// requires both universal sets). Also the registry read by
    /// [`grantable_admin_scopes`](facades::grantable_admin_scopes).
    fn required_scopes() -> Vec<Scope>;

    /// Build the service from the shared state. Called by [`Scoped`] **only after**
    /// every [`required_scopes`](GatedService::required_scopes) entry is covered,
    /// so constructing a facade is proof the scope check passed — there is no
    /// other public constructor.
    fn build(state: Arc<GatekeeperState>) -> Self;
}

/// Extractor that yields the service facade `F` iff the caller's verified token
/// covers `F`'s [`required_scopes`](GatedService::required_scopes); otherwise a
/// `403` [`insufficient_scope`](crate::http::errors::insufficient_scope) naming
/// the uncovered scopes. Derefs to `F`, so a handler writes
/// `grants: Scoped<GrantsRevoker>` and calls `grants.revoke(...)`.
pub(crate) struct Scoped<F: GatedService>(pub(crate) F);

impl<F: GatedService> std::ops::Deref for Scoped<F> {
    type Target = F;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<F: GatedService> FromRequestParts<Arc<GatekeeperState>> for Scoped<F> {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<GatekeeperState>,
    ) -> Result<Self, Self::Rejection> {
        // The claims are placed here by `require_valid_session`. Their absence is
        // a wiring bug (a `Scoped<…>` handler mounted without the authN layer),
        // not a client error — fail closed with a 500 rather than admit the
        // request or guess at a 401.
        let Some(claims) = parts.extensions.get::<VerifiedClaims>() else {
            return Err(errors::internal_error(
                "scoped service",
                "VerifiedClaims missing from request extensions; require_valid_session must run before a Scoped<…> handler",
            ));
        };
        let granted = grant_from_claims(claims);
        let missing: Vec<Scope> = F::required_scopes()
            .into_iter()
            .filter(|required| !granted.covers(required))
            .collect();
        if missing.is_empty() {
            Ok(Scoped(F::build(state.clone())))
        } else {
            Err(errors::insufficient_scope(scopes_rust::render_scopes(
                &missing,
            )))
        }
    }
}

/// Parse a token's space-separated `scope` claim into a coverage-checkable
/// [`Grant`]. Shared by [`Scoped`] and the caller-session extractor so both read
/// the caller's authority the same way. A missing `scope` claim yields an empty
/// grant (covers nothing) — fail-closed.
pub(crate) fn grant_from_claims(claims: &VerifiedClaims) -> Grant {
    Grant::parse(claims.scope.as_deref().unwrap_or("").split_whitespace())
}
