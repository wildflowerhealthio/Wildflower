//! The narrow, per-resource service facades the [`Scoped`](super::Scoped)
//! extractor hands out — one facade per (resource, permission) the `/access`
//! surface gates, each exposing only the store operations its scope authorizes.
//!
//! Each facade wraps a cheap `Arc<GatekeeperState>` clone (constructed **only**
//! inside `Scoped::from_request_parts`, after the covering-scope check) and
//! delegates to the existing [`crate::domain::actions`], so the store-touching
//! logic stays in one place and this layer only narrows *reachability*. The
//! `wildflower/<Resource>.<perm>` scope each requires is declared in its
//! [`GatedService::required_scopes`] impl — the single registry
//! [`grantable_admin_scopes`] also reads, so the enforced scopes and the
//! grantable-scope vocabulary can't drift apart.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, Utc};

use scopes_rust::{
    Grant, Permission, Scope, WildflowerResource, WildflowerResourceScope, WildflowerResourceType,
};

use super::GatedService;
use crate::domain::actions::{
    self, ApproveDeviceConsentInput, ApproveOAuthConsentInput, ConsentOutcome,
};
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::Grant as GrantRecord;
use crate::domain::PendingCodeConsent;
use crate::http::state::GatekeeperState;

/// Build a `wildflower/<Resource>.<perm>` scope — the required-scope shape every
/// facade below declares. Kept here so the registry reads one grammar and a typo
/// is a `WildflowerResource` enum error, not a silent `Unknown` scope.
fn wildflower_scope(resource: WildflowerResource, permission: Permission) -> Scope {
    Scope::WildflowerResource(WildflowerResourceScope {
        resource: WildflowerResourceType::Known(resource),
        permission,
    })
}

/// Read access to standing client grants — `GET /access/grants[/{id}]`.
pub(crate) struct GrantsReader {
    state: Arc<GatekeeperState>,
}

impl GatedService for GrantsReader {
    fn required_scopes() -> Vec<Scope> {
        vec![wildflower_scope(
            WildflowerResource::Grant,
            Permission::READ,
        )]
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        GrantsReader { state }
    }
}

impl GrantsReader {
    /// Every standing client grant, for the Owner UI's list.
    pub(crate) fn list(&self) -> Result<Vec<GrantRecord>, GatekeeperError> {
        actions::all_grants(&self.state.store)
    }

    /// A single grant by id, or [`GatekeeperError::GrantNotFound`] when absent.
    pub(crate) fn get(&self, id: &str) -> Result<GrantRecord, GatekeeperError> {
        actions::get_grant(&self.state.store, id)
    }
}

/// Revoke access to a standing grant — `DELETE /access/grants/{id}`. Distinct
/// from [`GrantsReader`] because deleting a grant is a `Grant.d` capability, and
/// it carries the security-critical token-kill cascade.
pub(crate) struct GrantsRevoker {
    state: Arc<GatekeeperState>,
}

impl GatedService for GrantsRevoker {
    fn required_scopes() -> Vec<Scope> {
        vec![wildflower_scope(
            WildflowerResource::Grant,
            Permission::DELETE,
        )]
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        GrantsRevoker { state }
    }
}

impl GrantsRevoker {
    /// Revoke the grant, bump the client's revocation epoch (killing its live
    /// access tokens), and expire its refresh-token families — the whole cascade,
    /// so no `offline_access` client outlives its revoked consent. The epoch bump
    /// lands before the delete so the security-critical step is first and the
    /// operation is idempotent on retry (see the original `/grants/{id}` handler).
    pub(crate) fn revoke(&self, id: &str, now: DateTime<Utc>) -> Result<(), GatekeeperError> {
        let grant = actions::get_grant(&self.state.store, id)?;
        self.state
            .revocation_store
            .revoke_subject_as_of_now(grant.client_id())
            .map_err(|e| GatekeeperError::infrastructure("revoke_subject_as_of_now failed", e))?;
        actions::revoke_grant(&self.state.store, id, grant.client_id(), now)
    }
}

/// A consent prompt loaded for the Owner UI to render — the data a `GET`
/// authorization-code consent handler needs, with the client's display name
/// already resolved.
pub(crate) struct OAuthConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) redirect_uri: url::Url,
    pub(crate) client_name: String,
}

/// A device-code consent prompt loaded for the Owner UI — adds the client's
/// full `allowed_scopes` (the expansion envelope the approver may grant up to).
pub(crate) struct DeviceConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) client_name: String,
    pub(crate) allowed_scopes: Vec<String>,
}

/// Read access to pending consent prompts — the `GET` sides of
/// `/access/oauth-consents/{id}` and `/access/devices/{userCode}`.
pub(crate) struct ConsentReader {
    state: Arc<GatekeeperState>,
}

impl GatedService for ConsentReader {
    fn required_scopes() -> Vec<Scope> {
        vec![wildflower_scope(
            WildflowerResource::AuthorizationRequest,
            Permission::READ,
        )]
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        ConsentReader { state }
    }
}

impl ConsentReader {
    /// The client's registered display name, or its raw `client_id` when the
    /// lookup misses or fails — the shared fallback both consent views use so the
    /// UI always has *something* to name the app.
    fn client_display_name(&self, client_id: &str) -> String {
        match actions::client_by_id(&self.state.store, client_id) {
            Ok(Some(client)) => client.name,
            _ => client_id.to_owned(),
        }
    }

    /// Load a pending authorization-code consent prompt for the Owner UI.
    pub(crate) fn oauth_consent(&self, id: &str) -> Result<OAuthConsentView, GatekeeperError> {
        let PendingCodeConsent {
            request,
            redirect_uri,
            ..
        } = actions::load_pending_authorization_code_request(&self.state.store, id)?;
        let client_name = self.client_display_name(&request.client_id);
        Ok(OAuthConsentView {
            request,
            redirect_uri,
            client_name,
        })
    }

    /// Load a pending device-code consent prompt for the Owner UI, with the
    /// client's name and expansion envelope resolved.
    pub(crate) fn device_consent(
        &self,
        user_code: &str,
    ) -> Result<DeviceConsentView, GatekeeperError> {
        let request = actions::load_pending_device_request(&self.state.store, user_code)?;
        let (client_name, allowed_scopes) =
            match actions::client_by_id(&self.state.store, &request.client_id) {
                Ok(Some(client)) => (client.name, client.allowed_scopes),
                // Fall back to the raw client_id and no expansion envelope on a
                // miss/failure — the UI still works, the approver just sees less.
                _ => (request.client_id.clone(), Vec::new()),
            };
        Ok(DeviceConsentView {
            request,
            client_name,
            allowed_scopes,
        })
    }
}

/// Decide (approve/deny) pending consent prompts — the `approve`/`deny` sides of
/// both consent surfaces. Gated by `AuthorizationRequest.u`; the approve paths
/// additionally clamp the grant to the approver's own scopes inside the domain
/// action (an approver can't delegate more than they hold).
pub(crate) struct ConsentDecider {
    state: Arc<GatekeeperState>,
}

impl GatedService for ConsentDecider {
    fn required_scopes() -> Vec<Scope> {
        vec![wildflower_scope(
            WildflowerResource::AuthorizationRequest,
            Permission::UPDATE,
        )]
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        ConsentDecider { state }
    }
}

impl ConsentDecider {
    /// Approve an authorization-code consent, clamped to `approver`'s scopes.
    pub(crate) fn approve_oauth(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        approver: &Grant,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        actions::approve_oauth_consent(
            &self.state.store,
            &self.state,
            id,
            input,
            approver,
            generate_code,
            now,
        )
    }

    /// Deny an authorization-code consent.
    pub(crate) fn deny_oauth(&self, id: &str) -> Result<(), GatekeeperError> {
        actions::deny_oauth_consent(&self.state.store, &self.state, id)
    }

    /// Approve a device-code consent, clamped to `approver`'s scopes.
    pub(crate) fn approve_device(
        &self,
        user_code: &str,
        input: ApproveDeviceConsentInput,
        approver: &Grant,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        actions::approve_device_consent(
            &self.state.store,
            &self.state,
            user_code,
            input,
            approver,
            now,
        )
    }

    /// Deny a device-code consent.
    pub(crate) fn deny_device(&self, user_code: &str) -> Result<(), GatekeeperError> {
        actions::deny_device_consent(&self.state.store, &self.state, user_code)
    }
}

/// Revoke issued tokens — `POST /access/revocations`. The `Token` resource is
/// broader than `RefreshToken`: a `jti` denylist or a subject epoch bump kills
/// live access **and** refresh tokens, so the capability is `Token.d`.
pub(crate) struct TokenRevoker {
    state: Arc<GatekeeperState>,
}

impl GatedService for TokenRevoker {
    fn required_scopes() -> Vec<Scope> {
        vec![wildflower_scope(
            WildflowerResource::Token,
            Permission::DELETE,
        )]
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        TokenRevoker { state }
    }
}

impl TokenRevoker {
    /// Denylist a single token by `jti` until its own expiry.
    pub(crate) fn revoke_jti(
        &self,
        jti: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        self.state
            .revocation_store
            .revoke_jti(jti, expires_at, "admin")
            .map_err(|e| GatekeeperError::infrastructure("revoke_jti failed", e))
    }

    /// Bulk-revoke a subject's whole token cohort via an epoch bump to now.
    pub(crate) fn revoke_subject(&self, subject: &str) -> Result<(), GatekeeperError> {
        self.state
            .revocation_store
            .revoke_subject_as_of_now(subject)
            .map_err(|e| GatekeeperError::infrastructure("revoke_subject_as_of_now failed", e))
    }
}

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
                include_str!("../routes/grants/list_all.rs"),
            ),
            (
                "grants/get_by_id",
                include_str!("../routes/grants/get_by_id.rs"),
            ),
            (
                "grants/revoke_by_id",
                include_str!("../routes/grants/revoke_by_id.rs"),
            ),
            (
                "oauth_consents/get",
                include_str!("../routes/oauth_consents/get.rs"),
            ),
            (
                "oauth_consents/approve",
                include_str!("../routes/oauth_consents/approve.rs"),
            ),
            (
                "oauth_consents/deny",
                include_str!("../routes/oauth_consents/deny.rs"),
            ),
            ("devices/get", include_str!("../routes/devices/get.rs")),
            (
                "devices/approve",
                include_str!("../routes/devices/approve.rs"),
            ),
            ("devices/deny", include_str!("../routes/devices/deny.rs")),
            ("revocations", include_str!("../routes/revocations.rs")),
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
