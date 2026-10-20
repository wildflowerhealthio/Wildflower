//! [`GrantsTx`] — the `authorization_code_grants` and `device_grants` tables
//! and the cross-kind `grants` view: the Owner's standing consent.

use url::Url;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};

/// The standing grants. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
pub trait GrantsTx {
    /// All grants in `granted_at` order — the cross-kind read off the `grants`
    /// view backing the launcher's access index.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the view read fails or a returned
    /// row cannot be mapped to a [`Grant`].
    fn all_grants(&mut self) -> Result<Vec<Grant>, AuthorizationServerError>;

    /// Load a single grant by primary id (a cross-kind read off the `grants`
    /// view; ids are UUIDs unique across both concrete tables), or `None` when
    /// absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the view read fails or the returned
    /// row cannot be mapped to a [`Grant`].
    fn grant_by_id(&mut self, id: &str) -> Result<Option<Grant>, AuthorizationServerError>;

    /// Find the standing authorization-code grant for a (`client_id`,
    /// `redirect_uri`) pair (the concrete-table lookup driving the `/authorize`
    /// fast path), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationCodeGrant`].
    fn grant_by_client_and_redirect(
        &mut self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, AuthorizationServerError>;

    /// Find the standing device grant for a (`client_id`, `device_name`) pair
    /// (the concrete-table lookup a re-pairing upserts against), or `None` when
    /// absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`DeviceGrant`].
    fn device_grant_by_client_and_device_name(
        &mut self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, AuthorizationServerError>;

    /// Insert a brand-new **authorization-code** grant row (a plain single-table
    /// insert). The caller hands the concrete grant — which table a write lands
    /// in is decided in the domain, not by the store re-inspecting a polymorphic
    /// value. The scope-union re-approval path is
    /// `GrantRecorder::record_code_grant`,
    /// which reads then chooses this or [`Self::update_authorization_code_grant`].
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails.
    fn create_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError>;

    /// Insert a brand-new **device** grant row (a plain single-table insert).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails.
    fn create_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError>;

    /// Overwrite the mutable fields (`scopes`, `granted_at`, `patient`) of the
    /// **authorization-code** grant identified by `grant.id` — the write half of
    /// a re-approval, after the action has folded the re-approval into `grant`
    /// via [`absorb_reapproval`](crate::domain::grant::CumulativeConsent).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn update_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError>;

    /// Overwrite the mutable fields of the **device** grant identified by
    /// `grant.id` — the write half of a device re-pairing.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn update_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError>;

    /// Delete the **authorization-code** grant `id`, returning `true` iff a row
    /// was removed. Half of a revoke; grant ids are UUIDs unique across both
    /// tables, so at most one of this and [`Self::delete_device_grant`] hits a
    /// row.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_authorization_code_grant(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError>;

    /// Delete the **device** grant `id`, returning `true` iff a row was removed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_device_grant(&mut self, id: &str) -> Result<bool, AuthorizationServerError>;
}
