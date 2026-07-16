//! Generic scope-gated service extractors — the reusable core of the
//! **default-safe** authorization pattern, lifted here so every `-rust` slice
//! that serves an HTTP surface can gate its endpoints the same way (the pattern
//! originated on gatekeeper's `/access` surface; see the gatekeeper
//! `http::scoped` module and `docs/Effect/Scope-Gated Endpoints How-To.md`).
//!
//! The shape a slice adopts:
//!
//! 1. An authN middleware verifies the caller once and inserts a value carrying
//!    the caller's scope claim into the request extensions — either the slice's
//!    own claims type (implementing [`GrantedScopes`]) or the ready-made
//!    [`ScopeClaims`].
//! 2. Each data-touching handler acquires the store **only** through a
//!    [`Scoped<F>`] extractor. It reads those claims, builds a coverage-checkable
//!    [`Grant`], and hands back the narrow service facade `F` **only if** the
//!    token covers `F`'s [`required_scopes`](GatedService::required_scopes) —
//!    otherwise a `403` naming the missing scopes ([`insufficient_scope`]).
//!
//! Because the facade is the sole door to the store for these handlers, a handler
//! that skips the scope check simply has no way to reach any data: the check
//! isn't a step you remember to add, it's the price of admission to the store. A
//! slice pairs this with a source-guard test (an `include_str!` assertion that
//! its handler files never touch the store directly) to make the "only door"
//! property a build failure to violate.
//!
//! Behind the `scope-gating` feature so non-HTTP crates stay free of `axum` /
//! `scopes-rust`.

use std::ops::Deref;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use scopes_rust::{Grant, Scope};

use crate::http_errors::InternalError;

/// The caller's granted scopes, read from whatever claims value a slice's authN
/// middleware stashed in the request extensions. Implemented by the slice's own
/// verified-claims type (gatekeeper's `VerifiedClaims`) or by the ready-made
/// [`ScopeClaims`] for slices that only need the scope string.
pub trait GrantedScopes: Clone + Send + Sync + 'static {
    /// Parse the caller's authority into a coverage-checkable [`Grant`]. A
    /// missing scope claim must yield an empty grant (covers nothing) — the
    /// authorization is fail-closed.
    fn granted(&self) -> Grant;
}

/// The minimal, framework-agnostic claims value a slice can insert into the
/// request extensions when it only needs the caller's scopes (not a full JWT
/// claim set). The gatekeeper bearer gate inserts one of these for every
/// downstream slice router, so a slice can scope-gate without depending on
/// gatekeeper's domain claims type.
#[derive(Debug, Clone)]
pub struct ScopeClaims {
    scope: Option<String>,
}

impl ScopeClaims {
    /// Wrap a token's space-separated `scope` claim (absent → covers nothing).
    #[must_use]
    pub fn new(scope: Option<String>) -> Self {
        Self { scope }
    }
}

impl GrantedScopes for ScopeClaims {
    fn granted(&self) -> Grant {
        Grant::parse(self.scope.as_deref().unwrap_or("").split_whitespace())
    }
}

/// A narrow, scope-gated view of a slice's store. Each implementor is a service
/// facade exposing just the operations one scope (or, for data-dependent gating,
/// the caller's whole [`Grant`]) authorizes; the [`Scoped`] extractor is the only
/// constructor, and it runs [`required_scopes`](GatedService::required_scopes) as
/// a gate first.
pub trait GatedService: Sized {
    /// The slice's router state (e.g. `Arc<GatekeeperState>`) — the same type the
    /// router is built over, so `Scoped<Self>` is a valid extractor for it.
    type State: Clone + Send + Sync + 'static;

    /// The claims value the slice's authN middleware inserts into the request
    /// extensions. [`ScopeClaims`] for the common case; a slice's own type when
    /// its handlers need more than the scopes.
    type Claims: GrantedScopes;

    /// The scope(s) the caller's token must cover — **all** of them — to obtain
    /// this service. Return several to express their conjunction. Return an empty
    /// vec when the coarse gate is "authenticated only" and the real check is
    /// **data-dependent** (a facade that gates per-resource from the caller's
    /// [`Grant`] inside its methods — see [`build`](GatedService::build)).
    fn required_scopes() -> Vec<Scope>;

    /// Build the service from the router state and the caller's granted scopes,
    /// called by [`Scoped`] **only after** every
    /// [`required_scopes`](GatedService::required_scopes) entry is covered — so
    /// constructing a facade is proof the static gate passed. A facade with a
    /// fixed capability ignores `granted`; a facade whose required scope depends
    /// on the target resource holds `granted` and re-checks coverage per call.
    fn build(state: Self::State, granted: &Grant) -> Self;
}

/// Extractor that yields the service facade `F` iff the caller's claims cover
/// `F`'s [`required_scopes`](GatedService::required_scopes); otherwise a `403`
/// [`insufficient_scope`] naming the uncovered scopes. Derefs to `F`, so a
/// handler writes `grants: Scoped<GrantsRevoker>` and calls `grants.revoke(...)`.
pub struct Scoped<F: GatedService>(pub F);

impl<F: GatedService> Deref for Scoped<F> {
    type Target = F;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<F: GatedService> FromRequestParts<F::State> for Scoped<F> {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &F::State,
    ) -> Result<Self, Self::Rejection> {
        // The claims are placed here by the slice's authN layer. Their absence is
        // a wiring bug (a `Scoped<…>` handler mounted without a claims-inserting
        // layer), not a client error — fail closed with a 500 rather than admit
        // the request or guess at a 401.
        let Some(claims) = parts.extensions.get::<F::Claims>() else {
            return Err(InternalError::new(
                "scoped service",
                "claims missing from request extensions; an authN layer that inserts \
                 the claims must run before a Scoped<…> handler",
            )
            .into_response());
        };
        let granted = claims.granted();
        let missing: Vec<Scope> = F::required_scopes()
            .into_iter()
            .filter(|required| !granted.covers(required))
            .collect();
        if missing.is_empty() {
            Ok(Scoped(F::build(state.clone(), &granted)))
        } else {
            Err(insufficient_scope(scopes_rust::render_scopes(&missing)))
        }
    }
}

/// Wire shape for a 403 — the caller authenticated, but their token doesn't cover
/// the scope(s) an operation requires. `missingScopes` names the scopes the
/// caller must additionally hold.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsufficientScopeBody {
    pub error: &'static str,
    pub missing_scopes: Vec<String>,
}

/// A `403 Forbidden` carrying the rendered scopes the caller lacks — the
/// authorization (not authentication) failure the scope-gated extractors and any
/// data-dependent facade return. Shared so every slice renders the same body.
#[must_use]
pub fn insufficient_scope(missing_scopes: Vec<String>) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(InsufficientScopeBody {
            error: "InsufficientScope",
            missing_scopes,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_claims_missing_claim_covers_nothing() {
        // Fail-closed: no `scope` claim → an empty grant that covers no scope.
        let claims = ScopeClaims::new(None);
        let granted = claims.granted();
        let some_scope = Scope::from("wildflower/Grant.r");
        assert!(!granted.covers(&some_scope));
    }

    #[test]
    fn scope_claims_parses_space_separated_scopes() {
        let claims = ScopeClaims::new(Some("wildflower/Grant.r system/*.r".to_owned()));
        let granted = claims.granted();
        assert!(granted.covers(&Scope::from("wildflower/Grant.r")));
        // A `system/*` (all-resources) grant covers a named FHIR resource read.
        assert!(granted.covers(&Scope::from("system/Observation.r")));
    }

    #[test]
    fn insufficient_scope_renders_a_403() {
        let response = insufficient_scope(vec!["wildflower/Grant.d".to_owned()]);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
