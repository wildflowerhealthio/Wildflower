//! Grant capabilities — the `wildflower/Grant.*` capabilities behind
//! `/access/grants[/{id}]`, and the grant operations they own. The store-touching
//! logic (`get_grant`, the `revoke_grant` cascade) lives here as `&impl
//! GatekeeperStore` functions so it stays unit-testable against the in-memory
//! fake; the capabilities are the scope-gated entries generic over the store,
//! holding the port dependencies lifted from the state (never `Arc<GatekeeperState>`).

use std::sync::Arc;

use chrono::{DateTime, Utc};

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::Grant;
use crate::domain::{GatekeeperStore, GatekeeperTx};
use crate::ports::Revocation;

/// The scope gating [`GrantsReader`] — `wildflower/Grant.r`. Shared by the
/// capability's `FixedScopeCapability` binding and
/// [`grantable_admin_scopes`](super::grantable_admin_scopes) so enforced and
/// grantable can't drift.
pub(crate) fn grants_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Grant,
        Permission::READ,
    )]
}

/// The scope gating [`GrantsRevoker`] — `wildflower/Grant.d`.
pub(crate) fn grants_revoker_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Grant,
        Permission::DELETE,
    )]
}

/// A single grant by id, or [`GatekeeperError::GrantNotFound`] when absent — the
/// `/access/grants/{id}` read (and the load-before-revoke).
fn get_grant(store: &impl GatekeeperStore, id: &str) -> Result<Grant, GatekeeperError> {
    store
        .grant_by_id(id)?
        .ok_or_else(|| GatekeeperError::GrantNotFound { id: id.to_owned() })
}

/// Revoke a grant and expire the client's refresh-token families in one
/// transaction, mapping the "no such grant" outcome onto
/// [`GatekeeperError::GrantNotFound`]. Both concrete tables are hit (grant ids
/// are UUIDs unique across them, so at most one deletes a row); doing the delete
/// and the family expiry in the same transaction means a partial failure can't
/// leave the grant deleted while `offline_access` refresh tokens stay live —
/// standing consent and standing credentials die together or not at all.
fn revoke_grant(
    store: &impl GatekeeperStore,
    grant_id: &str,
    client_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    let removed = store.transaction(|tx| {
        let removed_code = tx.delete_authorization_code_grant(grant_id)?;
        let removed_device = tx.delete_device_grant(grant_id)?;
        tx.expire_refresh_token_families_for_client(client_id, now)?;
        Ok(removed_code || removed_device)
    })?;
    if removed {
        Ok(())
    } else {
        Err(GatekeeperError::GrantNotFound {
            id: grant_id.to_owned(),
        })
    }
}

/// Read access to standing client grants — `GET /access/grants[/{id}]`. Generic
/// over the store port so it's unit-testable against the fake; the binding
/// instantiates it over the concrete `SqliteGatekeeperStore`.
pub(crate) struct GrantsReader<S: GatekeeperStore> {
    store: S,
}

impl<S: GatekeeperStore> GrantsReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        GrantsReader { store }
    }

    /// Every standing client grant, for the Owner UI's list.
    pub(crate) fn list(&self) -> Result<Vec<Grant>, GatekeeperError> {
        self.store.all_grants()
    }

    /// A single grant by id, or [`GatekeeperError::GrantNotFound`] when absent.
    pub(crate) fn get(&self, id: &str) -> Result<Grant, GatekeeperError> {
        get_grant(&self.store, id)
    }
}

/// Revoke access to a standing grant — `DELETE /access/grants/{id}`. Distinct
/// from [`GrantsReader`] because deleting a grant is a `Grant.d` capability, and
/// it carries the security-critical token-kill cascade — holds the [`Revocation`]
/// port for the epoch bump alongside the store.
pub(crate) struct GrantsRevoker<S: GatekeeperStore> {
    store: S,
    revocation: Arc<dyn Revocation>,
}

impl<S: GatekeeperStore> GrantsRevoker<S> {
    /// Build the revoker over a store handle + the revocation port, both lifted
    /// from the state.
    pub(crate) fn new(store: S, revocation: Arc<dyn Revocation>) -> Self {
        GrantsRevoker { store, revocation }
    }

    /// Revoke the grant, bump the client's revocation epoch (killing its live
    /// access tokens and refresh-token families), and delete the grant — the
    /// whole cascade, so no `offline_access` client outlives its revoked consent.
    /// The epoch bump lands before the delete so the security-critical step is
    /// first and the operation is idempotent on retry. Runs under this
    /// capability's own `Grant.d` gate; the token-kill is part of revoking a
    /// grant, so it does not additionally require `Token.d`.
    pub(crate) fn revoke(&self, id: &str, now: DateTime<Utc>) -> Result<(), GatekeeperError> {
        let grant = get_grant(&self.store, id)?;
        self.revocation
            .revoke_subject_as_of_now(grant.client_id())
            .map_err(|e| GatekeeperError::infrastructure("revoke_subject_as_of_now failed", e))?;
        revoke_grant(&self.store, id, grant.client_id(), now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{code_grant, FakeGatekeeperStore};

    #[test]
    fn get_grant_returns_the_row_or_grant_not_found() {
        let store = FakeGatekeeperStore::default();
        store
            .create_authorization_code_grant(&code_grant("g1", "client"))
            .unwrap();
        assert_eq!(get_grant(&store, "g1").unwrap().id(), "g1");
        assert_eq!(
            get_grant(&store, "ghost"),
            Err(GatekeeperError::GrantNotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn revoke_grant_maps_the_miss_to_grant_not_found() {
        let store = FakeGatekeeperStore::default();
        store
            .create_authorization_code_grant(&code_grant("g1", "client"))
            .unwrap();
        // First revoke removes the row and succeeds.
        assert_eq!(revoke_grant(&store, "g1", "client", Utc::now()), Ok(()));
        // Second revoke is a miss → GrantNotFound (both deletes returned `false`).
        assert_eq!(
            revoke_grant(&store, "g1", "client", Utc::now()),
            Err(GatekeeperError::GrantNotFound {
                id: "g1".to_owned()
            }),
        );
    }

    /// Revoke kills the grant AND expires the client's refresh-token families in
    /// one go: the family deadline is pulled back and its live token stamped
    /// consumed at the revoke instant, so standing consent and standing
    /// credentials die together.
    #[test]
    fn revoke_grant_also_expires_the_clients_refresh_families() {
        use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};

        let store = FakeGatekeeperStore::default();
        store
            .create_authorization_code_grant(&code_grant("g1", "client-a"))
            .unwrap();
        store
            .insert_refresh_token_family_row(&RefreshTokenFamily {
                family_id: "fam-1".to_owned(),
                client_id: "client-a".to_owned(),
                scopes: vec!["read".to_owned()],
                patient: None,
                issued_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::days(90),
                authorization_code_hash: None,
                grant_id: Some("g1".to_owned()),
            })
            .unwrap();
        store
            .insert_refresh_token(&RefreshToken {
                token_hash: "live".to_owned(),
                family_id: "fam-1".to_owned(),
                issued_at: Utc::now(),
                consumed_at: None,
            })
            .unwrap();

        let revoked_at = Utc::now();
        revoke_grant(&store, "g1", "client-a", revoked_at).unwrap();

        assert!(store.grant_by_id("g1").unwrap().is_none(), "grant gone");
        let (_token, family) = store
            .refresh_token_with_family_by_hash("live")
            .unwrap()
            .expect("row kept for auditability");
        assert_eq!(family.expires_at, revoked_at);
    }
}
