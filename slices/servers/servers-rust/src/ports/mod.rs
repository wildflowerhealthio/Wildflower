//! The ports the servers slice is used through. [`ServerRegistry`] is the
//! install's list of servers; its adapter is in [`crate::adapters`].

mod server_registry;

pub use server_registry::ServerRegistry;
