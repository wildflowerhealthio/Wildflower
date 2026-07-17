//! The `/access` surface's capabilities — the authorization (authZ) half of the
//! surface, and the mechanism that makes a forgotten permission check
//! structurally hard rather than merely a discipline.
//!
//! The generic machinery — the [`Scoped`] extractor and the
//! [`Capability`]/[`FixedScopeCapability`] traits — lives in
//! [`scope_capabilities_rust`], beside the scope grammar it enforces; this
//! module re-exports it and supplies the gatekeeper-specific capabilities, one
//! per (resource, permission) the surface gates, split by resource type:
//! [`grants`], [`consents`], [`tokens`].
//!
//! The [`require_valid_session`](crate::http::middleware::require_valid_session)
//! layer proves *who* the caller is (authN, `401` on failure) and stashes the
//! [`VerifiedClaims`](crate::domain::token::VerifiedClaims) in the request
//! extensions. Each `/access` handler then acquires the store **only** through a
//! [`Scoped<F>`] extractor: it reads those claims, builds a coverage-checkable
//! `Grant`, and hands back the narrow capability `F` **only if** the token
//! covers `F`'s required scope — otherwise a `403` naming the missing scopes.
//! Each capability wraps a cheap `Arc<GatekeeperState>` clone (constructed
//! **only** inside `Scoped::from_request_parts`, after the covering-scope check)
//! and delegates to the existing [`crate::domain::actions`], so the
//! store-touching logic stays in one place and this layer only narrows
//! *reachability*. Because the capability is the sole door to the store for
//! these handlers, a handler that skips the scope check simply has no way to
//! reach any data: the check isn't a step you remember to add, it's the price
//! of admission to the store.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `required_scopes` impl — and the same set is surfaced as
//! [`grantable_admin_scopes`], the admin half of the grantable-scope vocabulary.

mod consents;
mod grants;
mod tokens;

pub(crate) use consents::{ConsentDecider, ConsentReader};
pub(crate) use grants::{GrantsReader, GrantsRevoker};
pub(crate) use tokens::TokenRevoker;

pub(crate) use scope_capabilities_rust::{Capability, FixedScopeCapability, Scoped};

use std::collections::HashSet;

use scopes_rust::Scope;

/// The admin scopes the `/access` surface enforces, deduplicated in declaration
/// order — the registry mapping *capability → required scope*. Because it reads
/// the very `required_scopes` impls the extractor enforces, what a token can be
/// *granted* and what it is *checked against* come from one source. Exported as
/// the intended vocabulary for the consent surfaces; nothing consumes it yet
/// (the tests below pin it until the consent UI does), so a capability added
/// without registering here enforces a scope the vocabulary never offers —
/// register every new capability in `declared`.
pub fn grantable_admin_scopes() -> Vec<Scope> {
    let declared = [
        <GrantsReader as Capability>::required_scopes(),
        <GrantsRevoker as Capability>::required_scopes(),
        <ConsentReader as Capability>::required_scopes(),
        <ConsentDecider as Capability>::required_scopes(),
        <TokenRevoker as Capability>::required_scopes(),
    ];
    let mut seen = HashSet::new();
    declared
        .into_iter()
        .flatten()
        .filter(|scope| seen.insert(scope.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grantable_admin_scopes_are_the_expected_wildflower_scopes() {
        let rendered: Vec<String> = scopes_rust::render_scopes(&grantable_admin_scopes());
        assert_eq!(
            rendered,
            vec![
                "wildflower/Grant.r".to_owned(),
                "wildflower/Grant.d".to_owned(),
                "wildflower/AuthorizationRequest.r".to_owned(),
                "wildflower/AuthorizationRequest.u".to_owned(),
                "wildflower/Token.d".to_owned(),
            ],
        );
    }

    #[test]
    fn every_required_scope_is_a_known_wildflower_resource_not_unknown() {
        // A typo in a required-scope spelling would fall to `Scope::Unknown`,
        // which an owner's `wildflower/*.cruds` can't cover — locking the owner
        // out. Assert each is a real Wildflower resource scope so that can't ship.
        for scope in grantable_admin_scopes() {
            assert!(
                matches!(scope, Scope::WildflowerResource(_)),
                "required scope {scope} is not a wildflower resource scope",
            );
        }
    }

    /// Registry-completeness guard: every capability implemented in this module
    /// must be registered in [`grantable_admin_scopes`]'s `declared` array.
    /// A capability added without registering enforces a scope the grantable
    /// vocabulary never offers — a silent lock-out for every non-owner token.
    /// (Advisory-strength: it counts `impl … for` lines textually, so it keeps
    /// honest additions honest rather than defeating a determined evasion.)
    #[test]
    fn every_capability_impl_is_registered_in_the_grantable_vocabulary() {
        const CAPABILITY_SOURCES: &[&str] = &[
            include_str!("grants.rs"),
            include_str!("consents.rs"),
            include_str!("tokens.rs"),
        ];
        let implemented: usize = CAPABILITY_SOURCES
            .iter()
            .map(|source| {
                source.matches("impl FixedScopeCapability for").count()
                    + source.matches("impl Capability for").count()
            })
            .sum();
        // One `declared` entry per capability impl. Update BOTH when adding a
        // capability: its `required_scopes` impl and the `declared` array.
        let declared_entries = 5;
        assert_eq!(
            implemented, declared_entries,
            "found {implemented} capability impls but grantable_admin_scopes() declares \
             {declared_entries}; register the new capability in its `declared` array",
        );
    }

    /// Default-safety guard: the scope-gated `/access` handler files must reach
    /// the store **only** through a `Scoped<…>` capability — never a raw
    /// `State<Arc<GatekeeperState>>` or a direct `.store` / `.revocation_store`
    /// field access. Bypassing the capability would need one of these tokens,
    /// and this test fails if one appears, so a forgotten scope check can't
    /// ship silently.
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default — it must be consciously exempted below to escape.
    /// (Advisory-strength, deliberately: the needles are textual, so a comment
    /// containing `.store` false-positives and creative formatting could evade
    /// them. It back-stops the real seal — the capability being the only door —
    /// rather than replacing it.)
    #[test]
    fn access_handlers_reach_the_store_only_through_capabilities() {
        // Files that are legitimately NOT scope-gated: module glue, the pre-auth
        // public surface (`oauth/`, jwks), and self-service logout (authN-only by
        // design — see its doc comment).
        const EXEMPT_FILES: &[&str] = &["mod.rs", "logout.rs", "well_known_jwks.rs"];
        const EXEMPT_DIR_PREFIXES: &[&str] = &["oauth/"];
        const FORBIDDEN: &[&str] = &["State<", ".store", ".revocation_store"];

        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = path
                .strip_prefix(routes_dir)
                .expect("enumerated under routes_dir")
                .to_string_lossy()
                .replace('\\', "/");
            let file_name = relative.rsplit('/').next().unwrap_or(&relative);
            if EXEMPT_FILES.contains(&file_name)
                || EXEMPT_DIR_PREFIXES
                    .iter()
                    .any(|prefix| relative.starts_with(prefix))
            {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{relative}` reaches the store directly \
                     (`{needle}`); acquire it through a `Scoped<…>` capability instead",
                );
            }
            checked += 1;
        }
        // If the tree moves, this test must fail loudly rather than pass over
        // nothing.
        assert!(
            checked >= 10,
            "only {checked} handler files enumerated — did src/http/routes move?",
        );
    }

    fn rs_files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("enumerate {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("readable dir entry").path();
            if path.is_dir() {
                files.extend(rs_files_under(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
        files.sort();
        files
    }
}
