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

/// A [`utoipa::Modify`] addon that documents the shared `403 InsufficientScope`
/// on the operations of the given **gated paths** — so a slice declares the
/// authorization-failure response **once**, where it assembles its `OpenApi`,
/// instead of repeating `#[utoipa::path(responses((status = 403, …)))]` on every
/// scope-gated handler.
///
/// It injects only the `403` *response* (a `$ref` to `InsufficientScopeBody`).
/// Register the schema itself declaratively — add
/// `#[openapi(components(schemas(scope_capabilities_rust::InsufficientScopeBody)))]`
/// to the slice's `ApiDoc` — so the `$ref` resolves. Apply it after the routes
/// are merged (the paths must be present), e.g. in the slice's `openapi_spec()`:
///
/// ```ignore
/// use utoipa::Modify as _;
/// let mut spec = documented_router().split_for_parts().1;
/// InsufficientScopeResponses::for_paths(["/databases/{id}"]).modify(&mut spec);
/// ```
///
/// Paths match the generated OpenAPI path keys exactly (e.g. `"/databases/{id}"`,
/// `{id}` not `:id`). **Every** operation present on a listed path gets the 403,
/// so list only paths whose every method is scope-gated — a path mixing a gated
/// and a public method would need splitting (none do today). An operation that
/// already documents a `403` is left untouched.
#[cfg(feature = "openapi")]
#[derive(Debug, Clone)]
pub struct InsufficientScopeResponses {
    gated_paths: Vec<String>,
}

#[cfg(feature = "openapi")]
impl InsufficientScopeResponses {
    /// Document the shared 403 on every operation of each given gated path.
    #[must_use]
    pub fn for_paths<I, S>(gated_paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            gated_paths: gated_paths.into_iter().map(Into::into).collect(),
        }
    }
}

#[cfg(feature = "openapi")]
impl utoipa::Modify for InsufficientScopeResponses {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::{Content, Ref, RefOr, Response};

        for path in &self.gated_paths {
            let Some(item) = openapi.paths.paths.get_mut(path) else {
                continue;
            };
            let operations = [
                item.get.as_mut(),
                item.put.as_mut(),
                item.post.as_mut(),
                item.delete.as_mut(),
                item.options.as_mut(),
                item.head.as_mut(),
                item.patch.as_mut(),
                item.trace.as_mut(),
            ];
            for operation in operations.into_iter().flatten() {
                operation
                    .responses
                    .responses
                    .entry("403".to_owned())
                    .or_insert_with(|| {
                        let mut response = Response::new(
                            "The caller's token doesn't cover the scope this operation requires",
                        );
                        response.content.insert(
                            "application/json".to_owned(),
                            Content::new(Some(Ref::from_schema_name("InsufficientScopeBody"))),
                        );
                        RefOr::T(response)
                    });
            }
        }
    }
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

    /// The addon documents the 403 on every operation of a gated path, and on no
    /// operation of a path it isn't told about.
    #[cfg(feature = "openapi")]
    #[test]
    fn addon_documents_403_on_gated_paths_only() {
        use utoipa::openapi::path::OperationBuilder;
        use utoipa::openapi::{HttpMethod, OpenApiBuilder, PathItem, RefOr};
        use utoipa::Modify as _;

        let mut openapi = OpenApiBuilder::new().build();
        // A gated path with both a GET and a DELETE, and a separate public path.
        let mut gated = PathItem::new(HttpMethod::Get, OperationBuilder::new().build());
        gated.delete = Some(OperationBuilder::new().build());
        openapi.paths.paths.insert("/grants/{id}".to_owned(), gated);
        openapi.paths.paths.insert(
            "/token".to_owned(),
            PathItem::new(HttpMethod::Post, OperationBuilder::new().build()),
        );

        InsufficientScopeResponses::for_paths(["/grants/{id}"]).modify(&mut openapi);

        let gated = &openapi.paths.paths["/grants/{id}"];
        for op in [gated.get.as_ref(), gated.delete.as_ref()] {
            let response = op
                .expect("operation present")
                .responses
                .responses
                .get("403")
                .expect("gated operation documents a 403");
            match response {
                RefOr::T(response) => {
                    assert!(response.content.contains_key("application/json"));
                }
                RefOr::Ref(_) => panic!("expected an inline 403 response, not a $ref"),
            }
        }

        assert!(
            !openapi.paths.paths["/token"]
                .post
                .as_ref()
                .expect("post present")
                .responses
                .responses
                .contains_key("403"),
            "a path not listed as gated must not advertise a 403",
        );
    }

    /// An operation that already documents a 403 keeps its own — the addon fills
    /// gaps, it doesn't overwrite.
    #[cfg(feature = "openapi")]
    #[test]
    fn addon_leaves_an_existing_403_untouched() {
        use utoipa::openapi::path::OperationBuilder;
        use utoipa::openapi::{HttpMethod, OpenApiBuilder, PathItem, RefOr, Response};
        use utoipa::Modify as _;

        let mut operation = OperationBuilder::new().build();
        operation
            .responses
            .responses
            .insert("403".to_owned(), RefOr::T(Response::new("pre-existing")));
        let mut openapi = OpenApiBuilder::new().build();
        openapi.paths.paths.insert(
            "/grants".to_owned(),
            PathItem::new(HttpMethod::Get, operation),
        );

        InsufficientScopeResponses::for_paths(["/grants"]).modify(&mut openapi);

        let response = &openapi.paths.paths["/grants"]
            .get
            .as_ref()
            .expect("get present")
            .responses
            .responses["403"];
        match response {
            RefOr::T(response) => assert_eq!(response.description, "pre-existing"),
            RefOr::Ref(_) => panic!("expected the pre-existing inline response"),
        }
    }
}
