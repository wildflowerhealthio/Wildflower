//! The servers domain: [`ServerRecord`] and its parts, its
//! [`RunPolicy`](unit_runner::RunPolicy) included, [`RegistryError`], the
//! failure vocabulary of the
//! [`ServerRegistry`](crate::ServerRegistry) port; enrolment: [`add_server`]
//! and [`set_server_credentials`], which check a tunnel's credentials with its
//! relay through the [`RelayClient`](crate::RelayClient) port before writing
//! the registry, and [`EnrolmentError`]; and changing a registered server:
//! [`set_run_policy`] with its [`RunPolicyChoice`], [`update_server`] and
//! [`remove_server`], with [`ServerChangeError`]. Nothing
//! here touches the network, and only [`remove_server`] the filesystem, to
//! delete the server's folder.

mod enrolment;
mod enrolment_error;
mod registry_error;
mod run_policy_choice;
mod server_change_error;
mod server_changes;
mod server_record;

pub use enrolment::{add_server, set_server_credentials, EnteredRelay, RelayIdentity};
pub use enrolment_error::EnrolmentError;
pub use registry_error::RegistryError;
pub use run_policy_choice::RunPolicyChoice;
pub use server_change_error::ServerChangeError;
pub use server_changes::{remove_server, set_run_policy, update_server};
pub use server_record::{RelayKind, ServerRecord, TunnelToken, SERVERS_DIR_NAME};

#[cfg(test)]
pub(crate) use server_record::tests as fixtures;
