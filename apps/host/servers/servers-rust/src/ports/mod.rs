//! The ports `servers-rust` is used through. [`ServerRegistry`] is the
//! install's list of servers and [`RelayClient`] a client for a Wildflower
//! relay's own site, which enrolment asks for its settings and to confirm a
//! tunnel's credentials; their adapters are in [`crate::adapters`].

mod relay_client;
mod server_registry;

pub use relay_client::RelayClient;
pub(crate) use server_registry::registered_mut;
pub use server_registry::{NewRecord, RegistryChange, ServerRegistry};
