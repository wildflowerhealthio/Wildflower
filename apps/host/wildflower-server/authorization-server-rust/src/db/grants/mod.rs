//! Grant query bodies — ONE TABLE PER CONCRETE KIND, split by kind/context so each
//! kind's `table!` and single-kind queries sit together. Every body here is a
//! single-table statement (insert / keyed lookup / update / delete); cross-kind
//! reads ([`all_grants`], [`grant_by_id`]) come off the `grants` SQL VIEW. The
//! multi-statement flows that used to live here — the scope-union upserts and the
//! delete-both-then-expire revoke — moved to `domain::capabilities`, which
//! composes these primitives inside a
//! [`GrantStore`](crate::domain::GrantStore) transaction.
//!
//!  - [`authorization_code`] — the `authorization_code_grants` `table!` + its keyed
//!    lookup, insert, and update (`/authorize`'s standing consent per `redirect_uri`);
//!  - [`device`] — the `device_grants` `table!` + its keyed lookup, insert, and
//!    update (the durable device-code pairing per `device_name`);
//!  - [`general`] — the cross-kind pieces: the `grants` VIEW + its `Grant` decoder,
//!    the two launcher reads, and the two id-keyed deletes a revoke composes.
//!    Concrete-typed inserts live with their kind (the store never inspects a
//!    polymorphic value to pick a table).

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
