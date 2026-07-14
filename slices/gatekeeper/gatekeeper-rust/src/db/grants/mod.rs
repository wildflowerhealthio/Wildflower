//! Grant query bodies — ONE TABLE PER CONCRETE KIND, split by kind/context so each
//! kind's `table!` and single-kind queries sit together. Single-kind operations
//! (upserts, keyed lookups) hit their concrete table as single-table statements;
//! cross-kind reads ([`all_grants`], [`grant_by_id`]) come off the `grants` SQL
//! VIEW. There is no parent registry, so no parent-implies-child invariant to
//! enforce and no cross-table transaction anywhere except the revoke (grant delete
//! + refresh-family expiry, atomic together).
//!
//!  - [`authorization_code`] — the `authorization_code_grants` `table!` + its keyed
//!    lookup and upsert (`/authorize`'s standing consent per `redirect_uri`);
//!  - [`device`] — the `device_grants` `table!` + its keyed lookup and upsert (the
//!    durable device-code pairing per `device_name`);
//!  - [`general`] — the cross-kind pieces: the `grants` VIEW + its `Grant` decoder,
//!    the two Owner-UI reads, and the revoke that spans both tables + the client's
//!    refresh families. Concrete-typed inserts live with their kind (the store
//!    never inspects a polymorphic value to pick a table).

pub(crate) mod authorization_code;
pub(crate) mod device;
mod general;

pub(super) use authorization_code::{
    create_authorization_code_grant, grant_by_client_and_redirect, upsert_authorization_code_grant,
};
pub(super) use device::{
    create_device_grant, device_grant_by_client_and_device_name, upsert_device_grant,
};
pub(super) use general::{all_grants, grant_by_id, revoke_grant_and_expire_client_families};
