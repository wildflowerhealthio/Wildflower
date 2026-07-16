//! The narrow, per-resource service facades the [`Scoped`](crate::http::scoped::Scoped)
//! extractor hands out — one facade per (resource, permission) the `/access`
//! surface gates, each exposing only the store operations its scope authorizes.
//! Split by resource type: [`grants`], [`consents`], [`tokens`].
//!
//! Each facade wraps a cheap `Arc<GatekeeperState>` clone (constructed **only**
//! inside `Scoped::from_request_parts`, after the covering-scope check) and
//! delegates to the existing [`crate::domain::actions`], so the store-touching
//! logic stays in one place and this layer only narrows *reachability*. The
//! `wildflower/<Resource>.<perm>` scope each requires is declared in its
//! [`GatedService::required_scopes`] impl — the single registry
//! [`grantable_admin_scopes`] also reads, so the enforced scopes and the
//! grantable-scope vocabulary can't drift apart.

mod consents;
mod grants;
mod tokens;

pub(crate) use consents::{ConsentDecider, ConsentReader, DeviceConsentView, OAuthConsentView};
pub(crate) use grants::{GrantsReader, GrantsRevoker};
pub(crate) use tokens::TokenRevoker;

use std::collections::HashSet;

use scopes_rust::Scope;

use crate::http::scoped::GatedService;

/// The admin scopes the `/access` surface enforces, deduplicated in declaration
/// order — the registry mapping *service → required scope*, surfaced as the admin
/// half of the grantable-scope vocabulary the consent surfaces offer. Because it
/// reads the very [`GatedService::required_scopes`] impls the extractor enforces,
/// what a token can be *granted* and what it is *checked against* stay coupled.
pub fn grantable_admin_scopes() -> Vec<Scope> {
    let declared = [
        GrantsReader::required_scopes(),
        GrantsRevoker::required_scopes(),
        ConsentReader::required_scopes(),
        ConsentDecider::required_scopes(),
        TokenRevoker::required_scopes(),
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

    /// Default-safety guard: the scope-gated `/access` handler files must reach
    /// the store **only** through a `Scoped<…>` facade — never a raw
    /// `State<Arc<GatekeeperState>>` or a direct `.store` / `.revocation_store`
    /// field access. This is what makes a forgotten scope check impossible to
    /// ship silently: bypassing the facade would need one of these tokens, and
    /// this test fails the build if one appears. (`logout` is intentionally
    /// excluded — it is self-service, authN-only, and not a scope-gated resource
    /// op.)
    #[test]
    fn access_handlers_reach_the_store_only_through_facades() {
        const GATED_HANDLERS: &[(&str, &str)] = &[
            (
                "grants/list_all",
                include_str!("../../routes/grants/list_all.rs"),
            ),
            (
                "grants/get_by_id",
                include_str!("../../routes/grants/get_by_id.rs"),
            ),
            (
                "grants/revoke_by_id",
                include_str!("../../routes/grants/revoke_by_id.rs"),
            ),
            (
                "oauth_consents/get",
                include_str!("../../routes/oauth_consents/get.rs"),
            ),
            (
                "oauth_consents/approve",
                include_str!("../../routes/oauth_consents/approve.rs"),
            ),
            (
                "oauth_consents/deny",
                include_str!("../../routes/oauth_consents/deny.rs"),
            ),
            ("devices/get", include_str!("../../routes/devices/get.rs")),
            (
                "devices/approve",
                include_str!("../../routes/devices/approve.rs"),
            ),
            ("devices/deny", include_str!("../../routes/devices/deny.rs")),
            ("revocations", include_str!("../../routes/revocations.rs")),
        ];
        const FORBIDDEN: &[&str] = &["State<", ".store", ".revocation_store"];
        for (name, source) in GATED_HANDLERS {
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{name}` reaches the store directly (`{needle}`); \
                     acquire it through a `Scoped<…>` facade instead",
                );
            }
        }
    }
}
