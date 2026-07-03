//! Resource scopes — the `context/Type.perms` shapes — and the [`Permission`]s
//! (sets of interactions) they share.
//!
//! Grouped here so the FHIR ([`fhir`]) and Wildflower ([`wildflower`]) grammars
//! and their permission machinery ([`permission`]) stay encapsulated: the
//! submodules are private, only the scope types are re-exported up to
//! [`scope`](crate::scope), and the helper methods are scoped no wider than
//! `crate::scope`.

mod fhir;
mod permission;
mod wildflower;

pub use fhir::{ContextLevel, FhirResourceScope, ResourceType};
pub use permission::Permission;
pub use wildflower::{WildflowerResource, WildflowerResourceScope, WildflowerResourceType};

/// Drop a SMART v2 `?`-search-parameter suffix from a perms segment, warning on
/// what was discarded. `scope` is the full scope string, for the log. Shared by
/// the FHIR and Wildflower grammars.
pub(in crate::scope::resource) fn strip_search_suffix<'a>(scope: &str, perms: &'a str) -> &'a str {
    match perms.split_once('?') {
        Some((core, suffix)) => {
            tracing::warn!(
                scope = scope,
                suffix,
                "dropping unsupported SMART scope search-parameter suffix"
            );
            core
        }
        None => perms,
    }
}
