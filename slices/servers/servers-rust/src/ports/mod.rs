//! The ports the servers slice is used through. [`ServerRegistry`] is the
//! install's list of servers and [`RelaySite`] a relay's own site, which
//! enrolment asks for its settings and to confirm a tunnel's credentials;
//! their adapters are in [`crate::adapters`].

mod relay_site;
mod server_registry;

pub use relay_site::RelaySite;
pub use server_registry::ServerRegistry;
