//! The grants — one table per concrete kind, each kind's `table!` and
//! single-kind statements in its own file, and the [`GrantsTx`] primitives on
//! [`SqliteGrantTx`] here, each one statement in its kind's file. Cross-kind
//! reads come off the `grants` SQL view.
//!
//!  - [`authorization_code`] — the `authorization_code_grants` table: its keyed
//!    lookup, insert, and update (`/authorize`'s standing consent per
//!    `redirect_uri`);
//!  - [`device`] — the `device_grants` table: its keyed lookup, insert, and
//!    update (the durable device-code pairing per `device_name`);
//!  - `general` — the cross-kind pieces: the `grants` view and its `Grant`
//!    decoder, the two launcher reads, and the two id-keyed deletes a revoke
//!    composes.

use url::Url;

use crate::db::grant_store::SqliteGrantTx;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::grant_store::GrantsTx;

pub(crate) mod authorization_code;
pub(crate) mod device;
mod general;

/// The grant primitives, each a single-table statement in its kind's file.
impl GrantsTx for SqliteGrantTx<'_> {
    fn all_grants(&mut self) -> Result<Vec<Grant>, AuthorizationServerError> {
        general::all_grants(self.conn)
    }

    fn grant_by_id(&mut self, id: &str) -> Result<Option<Grant>, AuthorizationServerError> {
        general::grant_by_id(self.conn, id)
    }

    fn grant_by_client_and_redirect(
        &mut self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, AuthorizationServerError> {
        authorization_code::grant_by_client_and_redirect(self.conn, client_id, redirect_uri)
    }

    fn device_grant_by_client_and_device_name(
        &mut self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, AuthorizationServerError> {
        device::device_grant_by_client_and_device_name(self.conn, client_id, device_name)
    }

    fn create_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError> {
        authorization_code::create_authorization_code_grant(self.conn, grant)
    }

    fn create_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError> {
        device::create_device_grant(self.conn, grant)
    }

    fn update_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError> {
        authorization_code::update_authorization_code_grant(self.conn, grant)
    }

    fn update_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError> {
        device::update_device_grant(self.conn, grant)
    }

    fn delete_authorization_code_grant(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError> {
        general::delete_authorization_code_grant(self.conn, id)
    }

    fn delete_device_grant(&mut self, id: &str) -> Result<bool, AuthorizationServerError> {
        general::delete_device_grant(self.conn, id)
    }
}
