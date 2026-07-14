//! Grant actions over the [`GatekeeperStore`] port — the reads/upserts plus the
//! semantic `get_grant` / `revoke_grant` that map the store's absence/`false`
//! signals onto [`GatekeeperError::GrantNotFound`].

use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::GatekeeperStore;

/// Every standing grant — the Owner UI's access index.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn all_grants(store: &impl GatekeeperStore) -> Result<Vec<Grant>, GatekeeperError> {
    store.all_grants()
}

/// A single grant by id, or [`GatekeeperError::GrantNotFound`] when absent —
/// the `/access/grants/{id}` read (and the load-before-revoke).
///
/// # Errors
///
/// [`GatekeeperError::GrantNotFound`] when no grant has this id;
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn get_grant(store: &impl GatekeeperStore, id: &str) -> Result<Grant, GatekeeperError> {
    store
        .grant_by_id(id)?
        .ok_or_else(|| GatekeeperError::GrantNotFound { id: id.to_owned() })
}

/// The standing authorization-code grant for a (`client_id`, `redirect_uri`)
/// pair — the `/authorize` fast-path lookup.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn grant_by_client_and_redirect(
    store: &impl GatekeeperStore,
    client_id: &str,
    redirect_uri: &Url,
) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
    store.grant_by_client_and_redirect(client_id, redirect_uri)
}

/// The standing device grant for a (`client_id`, `device_name`) pair — the
/// token-exchange `grant_id` stamp.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn device_grant_by_client_and_device_name(
    store: &impl GatekeeperStore,
    client_id: &str,
    device_name: &str,
) -> Result<Option<DeviceGrant>, GatekeeperError> {
    store.device_grant_by_client_and_device_name(client_id, device_name)
}

/// Insert or cumulatively update the standing authorization-code grant.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn upsert_authorization_code_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    redirect_uri: &Url,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.upsert_authorization_code_grant(client_id, redirect_uri, scopes, patient, now)
}

/// Insert or cumulatively update the standing device grant.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn upsert_device_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    device_name: &str,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.upsert_device_grant(client_id, device_name, scopes, patient, now)
}

/// Revoke a grant (and expire the client's refresh-token families in the same
/// transaction), mapping the store's `false` "no such grant" outcome onto
/// [`GatekeeperError::GrantNotFound`] — so a revoke of an unknown/already-gone
/// grant renders the structured 404.
///
/// # Errors
///
/// [`GatekeeperError::GrantNotFound`] when no grant has this id;
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn revoke_grant(
    store: &impl GatekeeperStore,
    grant_id: &str,
    client_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    if store.revoke_grant_and_expire_client_families(grant_id, client_id, now)? {
        Ok(())
    } else {
        Err(GatekeeperError::GrantNotFound {
            id: grant_id.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_fake::{code_grant, FakeGatekeeperStore};
    use super::*;

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
        // Second revoke is a miss → GrantNotFound (the store returned `false`).
        assert_eq!(
            revoke_grant(&store, "g1", "client", Utc::now()),
            Err(GatekeeperError::GrantNotFound {
                id: "g1".to_owned()
            }),
        );
    }
}
