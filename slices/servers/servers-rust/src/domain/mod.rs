//! The servers domain: [`ServerRecord`] and its parts, and [`RegistryError`],
//! the failure vocabulary of the [`ServerRegistry`](crate::ServerRegistry)
//! port. Nothing here touches the filesystem.

mod registry_error;
mod server_record;

pub use registry_error::RegistryError;
pub use server_record::{Relay, ServerRecord, TunnelToken};

#[cfg(test)]
pub(crate) use server_record::tests as fixtures;
