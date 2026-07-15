//! Grant query bodies — ONE TABLE PER CONCRETE KIND, split by kind/context so each
//! kind's `table!` and single-kind queries sit together. Every body here is a
//! single-table statement (insert / keyed lookup / update / delete); cross-kind
//! reads ([`all_grants`], [`grant_by_id`]) come off the `grants` SQL VIEW. The
//! multi-statement flows that used to live here — the scope-union upserts and the
//! delete-both-then-expire revoke — moved to [`crate::domain::actions`], which
//! composes these primitives inside a
//! [`GatekeeperStore`](crate::domain::GatekeeperStore) transaction.
//!
//!  - [`authorization_code`] — the `authorization_code_grants` `table!` + its keyed
//!    lookup, insert, and update (`/authorize`'s standing consent per `redirect_uri`);
//!  - [`device`] — the `device_grants` `table!` + its keyed lookup, insert, and
//!    update (the durable device-code pairing per `device_name`);
//!  - [`general`] — the cross-kind pieces: the `grants` VIEW + its `Grant` decoder,
//!    the two Owner-UI reads, and the two id-keyed deletes a revoke composes.
//!    Concrete-typed inserts live with their kind (the store never inspects a
//!    polymorphic value to pick a table).

pub(crate) mod authorization_code;
pub(crate) mod device;
mod general;

pub(super) use authorization_code::{
    create_authorization_code_grant, grant_by_client_and_redirect, update_authorization_code_grant,
};
pub(super) use device::{
    create_device_grant, device_grant_by_client_and_device_name, update_device_grant,
};
pub(super) use general::{
    all_grants, delete_authorization_code_grant, delete_device_grant, grant_by_id,
};
