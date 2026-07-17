//! Scope-gated capability extractors — the reusable core of the **default-safe**
//! authorization pattern, and the enforcement half of the scope system (the
//! grammar half is `scopes-rust`, this crate's sibling in the scopes slice). The
//! pattern originated on gatekeeper's `/access` surface; the copy-this-pattern
//! recipe is `docs/Authorization/Scope-Gated Endpoints How-To.md`.
//!
//! The shape a slice adopts:
//!
//! 1. An authN middleware verifies the caller once and inserts a value carrying
//!    the caller's scope claim into the request extensions — either the slice's
//!    own claims type (implementing [`GrantedScopes`]) or the ready-made
//!    [`ScopeClaims`].
//! 2. Each data-touching handler acquires the store **only** through a
//!    [`Scoped<F>`] extractor. It reads those claims, builds a coverage-checkable
//!    [`Grant`], and hands back the narrow capability `F` **only if** the token
//!    covers `F`'s [`required_scopes`](Capability::required_scopes) — otherwise a
//!    `403` naming the missing scopes ([`insufficient_scope`]).
//!
//! A capability comes in two flavours, and the flavour is visible at the `impl`
//! line:
//!
//! - **Fixed-scope** — `impl FixedScopeCapability for …`: the whole capability is
//!   gated by one static scope set, checked by the extractor before `build` runs.
//!   Most capabilities are this flavour.
//! - **Data-dependent** — `impl Capability for …` directly: the required scope
//!   depends on *which* resource a method targets, so the extractor's static gate
//!   is empty ("authenticated only") and [`build`](Capability::build) stores the
//!   caller's [`Grant`] for the methods to re-check per call. A direct
//!   `Capability` impl that neither declares scopes nor stores the grant is a
//!   bug — that's what `FixedScopeCapability` is for.
//!
//! Because the capability is the sole door to the store for these handlers, a
//! handler that skips the scope check simply has no way to reach any data: the
//! check isn't a step you remember to add, it's the price of admission to the
//! store. A slice pairs this with a source-guard test (asserting its handler
//! files never touch the store directly) to make the "only door" property a test
//! failure to violate.

use std::ops::Deref;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use scopes_rust::{Grant, Scope};

use shared_structures_rust::http_errors::InternalError;

/// Parse a token's space-separated `scope` claim into a coverage-checkable
/// [`Grant`]. A missing claim yields an empty grant (covers nothing) — the one
/// fail-closed reading of a raw scope claim, shared by every [`GrantedScopes`]
/// implementor so gatekeeper's gate and a downstream slice's gate can't disagree
/// on how a claim string becomes authority.
#[must_use]
pub fn grant_from_scope_claim(scope: Option<&str>) -> Grant {
    Grant::parse(scope.unwrap_or("").split_whitespace())
}

/// The caller's granted scopes, read from whatever claims value a slice's authN
/// middleware stashed in the request extensions. Implemented by the slice's own
/// verified-claims type (gatekeeper's `VerifiedClaims`) or by the ready-made
/// [`ScopeClaims`] for slices that only need the scope string.
pub trait GrantedScopes: Clone + Send + Sync + 'static {
    /// Parse the caller's authority into a coverage-checkable [`Grant`]. A
    /// missing scope claim must yield an empty grant (covers nothing) — the
    /// authorization is fail-closed. Implement via [`grant_from_scope_claim`].
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
        grant_from_scope_claim(self.scope.as_deref())
    }
}

/// A narrow, scope-gated view of a slice's store — the **data-dependent**
/// flavour's trait, and the one the [`Scoped`] extractor drives. Implement
/// [`FixedScopeCapability`] instead when one static scope set gates the whole
/// capability (the common case); implement this directly only when the required
/// scope depends on the target resource, and then store `granted` for the
/// methods to re-check per call.
pub trait Capability: Sized {
    /// The slice's router state (e.g. `Arc<GatekeeperState>`) — the same type the
    /// router is built over, so `Scoped<Self>` is a valid extractor for it.
    type State: Clone + Send + Sync + 'static;

    /// The claims value the slice's authN middleware inserts into the request
    /// extensions. [`ScopeClaims`] for the common case; a slice's own type when
    /// its handlers need more than the scopes.
    type Claims: GrantedScopes;

    /// The scope(s) the caller's token must cover — **all** of them — to obtain
    /// this capability. Empty means the static gate is "authenticated only" and
    /// the real check is data-dependent inside the methods; a capability with a
    /// genuinely fixed scope should implement [`FixedScopeCapability`] instead so
    /// the flavour is visible at the impl line.
    fn required_scopes() -> Vec<Scope>;

    /// Build the capability from the router state and the caller's granted
    /// scopes, called by [`Scoped`] **only after** every
    /// [`required_scopes`](Capability::required_scopes) entry is covered — so
    /// constructing a capability is proof the static gate passed. A
    /// data-dependent capability stores `granted` and re-checks coverage per
    /// call.
    fn build(state: Self::State, granted: Grant) -> Self;
}

/// The **fixed-scope** flavour: one static scope set gates the whole capability,
/// so `build` never sees the caller's [`Grant`] — the extractor has already
/// checked it. The blanket impl lifts every `FixedScopeCapability` into
/// [`Capability`], so `Scoped<F>` works for both flavours.
pub trait FixedScopeCapability: Sized {
    /// See [`Capability::State`].
    type State: Clone + Send + Sync + 'static;
    /// See [`Capability::Claims`].
    type Claims: GrantedScopes;

    /// The static scope(s) gating this capability — must be non-empty (an empty
    /// requirement means the check is data-dependent, which is [`Capability`]
    /// implemented directly).
    fn required_scopes() -> Vec<Scope>;

    /// Build the capability from the router state alone; the covering-scope
    /// check already passed.
    fn build(state: Self::State) -> Self;
}

impl<F: FixedScopeCapability> Capability for F {
    type State = F::State;
    type Claims = F::Claims;

    fn required_scopes() -> Vec<Scope> {
        let scopes = F::required_scopes();
        // An empty requirement here is a misuse: it would gate nothing while
        // looking gated. The legitimate "empty" shape is a data-dependent
        // capability, which implements `Capability` directly and stores the Grant.
        debug_assert!(
            !scopes.is_empty(),
            "a FixedScopeCapability must require at least one scope; make the \
             capability data-dependent (impl Capability directly, storing the \
             Grant) if its check is per-resource",
        );
        scopes
    }

    fn build(state: F::State, _granted: Grant) -> Self {
        F::build(state)
    }
}

/// Extractor that yields the capability `F` iff the caller's claims cover `F`'s
/// [`required_scopes`](Capability::required_scopes); otherwise a `403`
/// [`insufficient_scope`] naming the uncovered scopes. Derefs to `F`, so a
/// handler writes `grants: Scoped<GrantsRevoker>` and calls `grants.revoke(...)`.
pub struct Scoped<F: Capability>(pub F);

impl<F: Capability> Deref for Scoped<F> {
    type Target = F;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<F: Capability> FromRequestParts<F::State> for Scoped<F> {
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
                "scoped capability",
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
            Ok(Scoped(F::build(state.clone(), granted)))
        } else {
            Err(insufficient_scope(scopes_rust::render_scopes(&missing)))
        }
    }
}

/// Wire shape for a 403 — the caller authenticated, but their token doesn't cover
/// the scope(s) an operation requires. `missingScopes` names the scopes the
/// caller must additionally hold.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct InsufficientScopeBody {
    /// Always `"InsufficientScope"` — the discriminant a client switches on.
    pub error: &'static str,
    /// The rendered scopes the caller lacks.
    pub missing_scopes: Vec<String>,
}

/// A `403 Forbidden` carrying the rendered scopes the caller lacks — the
/// authorization (not authentication) failure the scope-gated extractors and any
/// data-dependent capability return. Shared so every slice renders the same body.
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
