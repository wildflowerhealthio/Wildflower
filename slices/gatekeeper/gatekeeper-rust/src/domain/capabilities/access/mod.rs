//! The `/access` surface's capabilities — the **scope-gated** group, unlocked
//! by the caller's scopes: the authorization (authZ) half of the Owner surface,
//! living in `domain/` beside the store port they operate through (not in
//! `crate::http`), so a forgotten permission check is structurally hard rather
//! than merely a discipline. Their privileged writes go through the sibling
//! [`writers`](crate::domain::capabilities::writers) under an authority proof.
//!
//! The generic machinery — the [`Scoped`] extractor and the
//! [`Capability`]/[`FixedScopeCapability`] traits — lives in
//! [`scope_capabilities_rust`]; this module supplies the gatekeeper-specific
//! capabilities, one per (resource, permission) the surface gates, split by
//! resource type: [`grants`], [`consents`], [`tokens`]. Each capability is
//! **generic over the store port** (`Cap<S: GatekeeperStore>`) and holds the port
//! dependencies (store, [`Revocation`](crate::ports::Revocation),
//! [`PendingConsentPublisher`](crate::ports::PendingConsentPublisher)) **lifted
//! from the state** — never an `Arc<GatekeeperState>` it reaches into — so its
//! logic is unit-testable against the in-memory fake. The `Capability` bindings
//! that name the concrete `SqliteGatekeeperStore` and build a capability from the
//! router state live in the composition layer (`crate::live_bindings`), so `domain/`
//! stays store-agnostic.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `*_scopes()` function — read by **both** its `Capability` binding
//! and [`grantable_admin_scopes`], so *enforced* and *grantable* can't drift.

pub(crate) mod consents;
pub(crate) mod grants;
pub(crate) mod tokens;

pub(crate) use consents::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, ConsentDecider, ConsentOutcome,
    ConsentReader, DeviceConsentView, OAuthConsentView,
};
pub(crate) use grants::{GrantsReader, GrantsRevoker};
pub(crate) use tokens::TokenRevoker;

pub(crate) use scope_capabilities_rust::{Capability, FixedScopeCapability, Scoped};

use std::collections::HashSet;

use scopes_rust::Scope;

/// The admin scopes the `/access` surface enforces, deduplicated in declaration
/// order — the registry mapping *capability → required scope*. Because it reads
/// the very `*_scopes()` functions the `Capability` bindings enforce, what a
/// token can be *granted* and what it is *checked against* come from one source.
/// Exported as the intended vocabulary for the consent surfaces; nothing consumes
/// it yet (the tests below pin it until the consent UI does).
pub fn grantable_admin_scopes() -> Vec<Scope> {
    let declared = [
        grants::grants_reader_scopes(),
        grants::grants_revoker_scopes(),
        consents::consent_reader_scopes(),
        consents::consent_decider_scopes(),
        tokens::token_revoker_scopes(),
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
    use crate::domain::source_guard::{production_lines, relative_to, rs_files_under};

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

    /// Registry-completeness guard: every capability declares exactly one
    /// `*_scopes()` function, and [`grantable_admin_scopes`]'s `declared` array
    /// must list all of them. A capability added without registering enforces a
    /// scope the grantable vocabulary never offers — a silent lock-out. Counting
    /// the scope functions textually keeps honest additions honest.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        const CAPABILITY_SOURCES: &[&str] = &[
            include_str!("grants.rs"),
            include_str!("consents/mod.rs"),
            include_str!("tokens.rs"),
        ];
        let scope_fns: usize = CAPABILITY_SOURCES
            .iter()
            .map(|source| source.matches("_scopes() -> Vec<Scope>").count())
            .sum();
        // One `declared` entry per capability's scope function. Update BOTH when
        // adding a capability: its `*_scopes()` fn and the `declared` array.
        let declared_entries = 5;
        assert_eq!(
            scope_fns, declared_entries,
            "found {scope_fns} capability scope functions but grantable_admin_scopes() declares \
             {declared_entries}; register the new capability in its `declared` array",
        );
    }

    /// Default-safety guard: every handler file reaches the store **only**
    /// through a capability extractor — `Scoped<…>` (scope-gated),
    /// `Authenticated<…>` (the caller's own session), or `Live<…>` (the
    /// pre-auth front door, whose gate is the proof its methods take) — never a
    /// raw `State<Arc<GatekeeperState>>` or a state field. This test fails if
    /// one appears, so a forgotten gate can't ship silently.
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default; only module glue (`mod.rs`) is exempt. (Advisory-
    /// strength, deliberately: the needles are textual; comments and unit-test
    /// modules are skipped.)
    #[test]
    fn handlers_reach_the_state_only_through_capabilities() {
        // Raw router state, or any field of it — the only ways to reach data
        // or a seam without a capability.
        const FORBIDDEN: &[&str] = &[
            "State<",
            ".store",
            ".revocation_store",
            ".first_party_client_id",
            ".self_hosted_redirects",
            ".active_pending_consent_sender",
            ".loopback_base_url",
        ];

        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = relative_to(&path, routes_dir);
            if relative.ends_with("mod.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for (n, line) in production_lines(&source) {
                for needle in FORBIDDEN {
                    assert!(
                        !line.contains(needle),
                        "handler `{relative}:{n}` reaches the state directly (`{needle}`); \
                         acquire a capability through `Scoped<…>`, `Authenticated<…>`, or \
                         `Live<…>` instead",
                    );
                }
            }
            checked += 1;
        }
        assert!(
            checked >= 15,
            "only {checked} handler files enumerated — did src/http/routes move?",
        );
    }

    /// The authN gates verify a token through the `TokenVerifier` capability,
    /// not against the stores directly, so the verification policy has exactly
    /// one home. Same textual strength as the handler guard.
    #[test]
    fn middleware_verifies_only_through_the_token_verifier() {
        const FORBIDDEN: &[&str] = &[".store", ".revocation_store"];
        let middleware_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/middleware"));
        let mut checked = 0;
        for path in rs_files_under(middleware_dir) {
            let relative = relative_to(&path, middleware_dir);
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read middleware source {relative}: {e}"));
            for (n, line) in production_lines(&source) {
                for needle in FORBIDDEN {
                    assert!(
                        !line.contains(needle),
                        "middleware `{relative}:{n}` reaches a store directly (`{needle}`); \
                         verify through `LiveTokenVerifier` instead",
                    );
                }
            }
            checked += 1;
        }
        assert!(
            checked >= 3,
            "only {checked} middleware files enumerated — did src/http/middleware move?",
        );
    }
}
