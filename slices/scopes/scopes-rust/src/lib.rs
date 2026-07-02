//! OAuth 2.0 and SMART on FHIR scope primitives.
//!
//! [`scope`] is the structured, owned [`Scope`] model — parse, render, and
//! coverage. [`smart`] keeps the string-facing grammar entry points
//! (`grantable_scopes`, `allowed_scope_covers`) that gatekeeper's consent
//! handlers call, implemented on top of the model.

pub mod scope;
pub mod smart;

pub use scope::{
    ContextLevel, FhirResourceScope, Grant, KnownScope, Permission, ResourceType, Scope,
    UnknownScope, WildflowerResource, WildflowerResourceScope, WildflowerResourceType,
};
pub use smart::{allowed_scope_covers, grantable_scopes, with_alternate_canonical_forms};

/// Render a slice of [`Scope`]s to their canonical wire strings — the shape
/// stored in client `allowed_scopes`/grant rows and minted into a token's
/// space-joined `scope` claim. Consolidates the `…map(ToString::to_string)…`
/// idiom callers would otherwise repeat.
pub fn render_scopes(scopes: &[Scope]) -> Vec<String> {
    scopes.iter().map(ToString::to_string).collect()
}
