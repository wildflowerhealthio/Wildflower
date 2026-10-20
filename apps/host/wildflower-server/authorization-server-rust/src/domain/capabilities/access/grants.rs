//! Grant capabilities — the `wildflower/Grant.*` capabilities behind
//! `/authorization/grants[/{id}]`: read the standing grants, and revoke one with
//! the token-kill cascade. Generic over the store, holding the port
//! dependencies lifted from the state, so each is unit-testable against the
//! in-memory fake.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant::Grant;
use crate::domain::grant_store::{GrantsTx as _, RefreshTokensTx as _};
use crate::domain::GrantStore;
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

/// Read access to standing client grants — `GET /authorization/grants[/{id}]`. Generic
/// over the store port so it's unit-testable against the fake; the binding
/// instantiates it over the concrete `SqliteGrantStore`.
pub(crate) struct GrantsReader<S: GrantStore> {
    /// The store the grants are read from.
    store: S,
}

impl<S: GrantStore> GrantsReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        GrantsReader { store }
    }

    /// Every standing client grant, code-flow and device alike, for the
    /// launcher's list.
    pub(crate) fn list(&self) -> Result<Vec<Grant>, AuthorizationServerError> {
        self.store.read(|tx| tx.all_grants())
    }

    /// A single grant by id, or [`AuthorizationServerError::GrantNotFound`] when absent.
    pub(crate) fn get(&self, id: &str) -> Result<Grant, AuthorizationServerError> {
        self.store
            .read(|tx| tx.grant_by_id(id))?
            .ok_or_else(|| grant_not_found(id))
    }
}

/// Revoke access to a standing grant — `DELETE /authorization/grants/{id}`. Distinct
/// from [`GrantsReader`] because deleting a grant is a `Grant.d` capability, and
/// it carries the security-critical token-kill cascade — holds the [`Revocation`]
/// port for the epoch bump alongside the store.
pub(crate) struct GrantsRevoker<S: GrantStore> {
    /// The store the grant is deleted from and the client's refresh-token
    /// families are expired in.
    store: S,
    /// The revocation store, whose per-subject epoch ends every live access
    /// token the grant's client holds.
    revocation: Arc<dyn Revocation>,
}

impl<S: GrantStore> GrantsRevoker<S> {
    /// Build the revoker over a store handle + the revocation port, both lifted
    /// from the state.
    pub(crate) fn new(store: S, revocation: Arc<dyn Revocation>) -> Self {
        GrantsRevoker { store, revocation }
    }

    /// Revoke the grant `id`: bump its client's revocation epoch, killing its
    /// live access tokens, then delete the grant and expire the client's
    /// refresh-token families in one write scope, so standing consent and
    /// standing credentials die together — the whole cascade, so no
    /// `offline_access` client outlives its revoked consent. Runs under this
    /// capability's own `Grant.d` gate; the token-kill is part of revoking a
    /// grant, so it does not additionally require `Token.d`.
    ///
    /// The one capability with two scopes: a `read` scope loads the grant for
    /// its client, the epoch is bumped, and a `write` scope deletes. The epoch
    /// lives on the revocation store, so its bump can't sit inside this
    /// store's write lock, and it goes first: a bump that over-revokes on a
    /// failed delete is recoverable (a retry finds the grant and finishes),
    /// while a delete that commits without its bump leaves live access tokens
    /// and a retry that answers 404.
    ///
    /// The epoch and the families are per client, not per grant: revoking one
    /// of a client's grants ends every access token and refresh-token family
    /// the client holds. Both concrete grant tables are hit (grant ids are
    /// UUIDs unique across them, so at most one deletes a row).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::GrantNotFound`] when no grant has `id`, or
    /// it vanished between the read and the delete; a store or
    /// revocation-store failure.
    pub(crate) fn revoke(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        let grant = self
            .store
            .read(|tx| tx.grant_by_id(id))?
            .ok_or_else(|| grant_not_found(id))?;
        self.revocation
            .revoke_subject_as_of_now(grant.client_id())
            .map_err(|e| {
                AuthorizationServerError::infrastructure("revoke_subject_as_of_now failed", e)
            })?;
        self.store.write(|tx| {
            let removed_code = tx.delete_authorization_code_grant(id)?;
            let removed_device = tx.delete_device_grant(id)?;
            if !(removed_code || removed_device) {
                return Err(grant_not_found(id));
            }
            tx.expire_refresh_token_families_for_client(grant.client_id(), now)
        })
    }
}

/// No grant has `id`.
fn grant_not_found(id: &str) -> AuthorizationServerError {
    AuthorizationServerError::GrantNotFound { id: id.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{code_grant, FakeGrantStore};

    /// The revocation port, recording each subject whose epoch is bumped.
    #[derive(Default)]
    struct SubjectsRevoked(std::sync::Mutex<Vec<String>>);

    impl Revocation for SubjectsRevoked {
        fn revoke_jti(&self, _: &str, _: DateTime<Utc>, _: &str) -> Result<(), String> {
            Ok(())
        }

        fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), String> {
            self.0.lock().expect("lock").push(subject.to_owned());
            Ok(())
        }
    }

    /// A stored grant comes back by its id; an unknown id is `GrantNotFound`
    /// naming it.
    #[test]
    fn get_returns_the_row_or_grant_not_found() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .create_authorization_code_grant(&code_grant("g1", "client"))
            .unwrap();
        let reader = GrantsReader::new(store);
        assert_eq!(reader.get("g1").unwrap().id(), "g1");
        assert_eq!(
            reader.get("ghost"),
            Err(AuthorizationServerError::GrantNotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    /// A revoke removes the grant and bumps its client's epoch; a second one
    /// is a miss, which bumps nothing.
    #[test]
    fn revoke_maps_the_miss_to_grant_not_found() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .create_authorization_code_grant(&code_grant("g1", "client"))
            .unwrap();
        let revocation = Arc::new(SubjectsRevoked::default());
        let revoker = GrantsRevoker::new(store, revocation.clone());
        assert_eq!(revoker.revoke("g1", Utc::now()), Ok(()));
        assert_eq!(
            revoker.revoke("g1", Utc::now()),
            Err(AuthorizationServerError::GrantNotFound {
                id: "g1".to_owned()
            }),
        );
        assert_eq!(*revocation.0.lock().unwrap(), ["client".to_owned()]);
    }

    /// Revoke kills the grant AND expires the client's refresh-token families in
    /// one go: the family deadline is pulled back and its live token stamped
    /// consumed at the revoke instant, so standing consent and standing
    /// credentials die together.
    #[test]
    fn revoke_also_expires_the_clients_refresh_families() {
        use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};

        let store = FakeGrantStore::default();
        store
            .tx()
            .create_authorization_code_grant(&code_grant("g1", "client-a"))
            .unwrap();
        store
            .tx()
            .insert_refresh_token_family_row(&RefreshTokenFamily {
                family_id: "fam-1".to_owned(),
                client_id: "client-a".to_owned(),
                scopes: vec!["read".to_owned()],
                patient: None,
                issued_at: Utc::now(),
                expires_at: Utc::now() + chrono::Duration::days(90),
                authorization_code_hash: None,
                grant_id: Some("g1".to_owned()),
                sid: None,
            })
            .unwrap();
        store
            .tx()
            .insert_refresh_token(&RefreshToken {
                token_hash: "live".to_owned(),
                family_id: "fam-1".to_owned(),
                issued_at: Utc::now(),
                consumed_at: None,
            })
            .unwrap();

        let revoked_at = Utc::now();
        let revoker = GrantsRevoker::new(store, Arc::new(SubjectsRevoked::default()));
        revoker.revoke("g1", revoked_at).unwrap();

        assert!(
            revoker.store.tx().grant_by_id("g1").unwrap().is_none(),
            "grant gone"
        );
        let (_token, family) = revoker
            .store
            .tx()
            .refresh_token_with_family_by_hash("live")
            .unwrap()
            .expect("row kept for auditability");
        assert_eq!(family.expires_at, revoked_at);
    }
}
