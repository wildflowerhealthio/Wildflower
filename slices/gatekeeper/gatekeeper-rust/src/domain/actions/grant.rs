//! Grant actions over the [`GatekeeperStore`] port — the reads/upserts plus the
//! semantic `get_grant` / `revoke_grant` that map the store's absence/`false`
//! signals onto [`GatekeeperError::GrantNotFound`].

use chrono::{DateTime, Utc};
use url::Url;
use uuid::Uuid;

use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, CumulativeConsent, DeviceGrant, Grant};
use crate::domain::{GatekeeperStore, GatekeeperTx};

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

/// Insert or cumulatively update the standing authorization-code grant for
/// `(client_id, redirect_uri)`, all inside one `BEGIN IMMEDIATE` transaction:
/// read the standing grant; if present, fold the re-approval in via
/// [`CumulativeConsent::absorb_reapproval`] (order-preserving scope union,
/// refreshed consent instant + patient) and write it back; otherwise mint a
/// fresh grant. `BEGIN IMMEDIATE` takes the write lock before the read, so two
/// concurrent approvals serialise at the read rather than both reading the
/// pre-merge row and one losing its scope union.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the transaction, read, or write fails.
pub(crate) fn upsert_authorization_code_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    redirect_uri: &Url,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.immediate_transaction(|tx| {
        match tx.grant_by_client_and_redirect(client_id, redirect_uri)? {
            Some(mut grant) => {
                grant.absorb_reapproval(scopes, patient, now);
                tx.update_authorization_code_grant(&grant)
            }
            None => tx.create_authorization_code_grant(&AuthorizationCodeGrant {
                id: Uuid::new_v4().to_string(),
                client_id: client_id.to_owned(),
                scopes: scopes.to_vec(),
                granted_at: now,
                last_used_at: None,
                patient: patient.map(str::to_owned),
                redirect_uri: redirect_uri.clone(),
            }),
        }
    })
}

/// Insert or cumulatively update the standing device grant for
/// `(client_id, device_name)`, with the same read-merge-write-under-`BEGIN
/// IMMEDIATE` shape as [`upsert_authorization_code_grant`] — keyed on the device
/// name instead of the redirect URI.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the transaction, read, or write fails.
pub(crate) fn upsert_device_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    device_name: &str,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.immediate_transaction(|tx| {
        match tx.device_grant_by_client_and_device_name(client_id, device_name)? {
            Some(mut grant) => {
                grant.absorb_reapproval(scopes, patient, now);
                tx.update_device_grant(&grant)
            }
            None => tx.create_device_grant(&DeviceGrant {
                id: Uuid::new_v4().to_string(),
                client_id: client_id.to_owned(),
                scopes: scopes.to_vec(),
                granted_at: now,
                last_used_at: None,
                patient: patient.map(str::to_owned),
                device_name: device_name.to_owned(),
            }),
        }
    })
}

/// Revoke a grant and expire the client's refresh-token families in one
/// transaction, mapping the "no such grant" outcome onto
/// [`GatekeeperError::GrantNotFound`] — so a revoke of an unknown/already-gone
/// grant renders the structured 404. Both concrete tables are hit (grant ids are
/// UUIDs unique across them, so at most one deletes a row); doing the delete and
/// the family expiry in the same transaction means a partial failure can't leave
/// the grant deleted while `offline_access` refresh tokens stay live — standing
/// consent and standing credentials die together or not at all.
///
/// # Errors
///
/// [`GatekeeperError::GrantNotFound`] when no grant has this id;
/// [`GatekeeperError::Infrastructure`] if the transaction or any statement fails.
pub(crate) fn revoke_grant(
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
        // Second revoke is a miss → GrantNotFound (both deletes returned `false`).
        assert_eq!(
            revoke_grant(&store, "g1", "client", Utc::now()),
            Err(GatekeeperError::GrantNotFound {
                id: "g1".to_owned()
            }),
        );
    }

    /// The upsert action's own logic — read, union, write-back — over the fake:
    /// a first approval inserts, a re-approval keeps the same row and unions the
    /// scopes (order-preserving) while refreshing the patient context. The
    /// diesel-backed twin of this lives in `db::grants::authorization_code`.
    #[test]
    fn upsert_authorization_code_grant_inserts_then_unions_scopes() {
        let store = FakeGatekeeperStore::default();
        let redirect = Url::parse("https://example.com/cb").unwrap();

        upsert_authorization_code_grant(
            &store,
            "client-a",
            &redirect,
            &["read".to_owned()],
            Some("pat-1"),
            Utc::now(),
        )
        .unwrap();
        let first = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .unwrap()
            .expect("grant inserted");
        assert_eq!(first.scopes, vec!["read".to_owned()]);
        assert_eq!(first.patient.as_deref(), Some("pat-1"));

        upsert_authorization_code_grant(
            &store,
            "client-a",
            &redirect,
            &["read".to_owned(), "write".to_owned()],
            Some("pat-2"),
            Utc::now(),
        )
        .unwrap();
        let merged = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .unwrap()
            .expect("grant present");
        assert_eq!(
            merged.id, first.id,
            "the same grant is updated, not duplicated"
        );
        assert_eq!(merged.scopes, vec!["read".to_owned(), "write".to_owned()]);
        assert_eq!(merged.patient.as_deref(), Some("pat-2"));
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
        let (token, family) = store
            .refresh_token_with_family_by_hash("live")
            .unwrap()
            .expect("row kept for auditability");
        assert_eq!(family.expires_at, revoked_at);
        assert_eq!(token.consumed_at, Some(revoked_at));
    }
}
