//! The servers domain: [`ServerRecord`] and its parts, [`RegistryError`], the
//! failure vocabulary of the [`ServerRegistry`](crate::ServerRegistry) port,
//! and enrolment: [`add_server`] and [`set_server_credentials`], which check
//! a tunnel's credentials with its relay through the
//! [`RelayClient`](crate::RelayClient) port before writing the registry, and
//! [`EnrolmentError`]. Nothing here touches the filesystem or the network.

mod enrolment;
mod enrolment_error;
mod registry_error;
mod server_record;

pub use enrolment::{add_server, set_server_credentials, EnteredRelay, RelayIdentity};
pub use enrolment_error::EnrolmentError;
pub use registry_error::RegistryError;
pub use server_record::{RelayKind, ServerRecord, TunnelToken};

#[cfg(test)]
pub(crate) use server_record::tests as fixtures;
