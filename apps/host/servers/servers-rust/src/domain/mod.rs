//! The servers domain: [`ServerRecord`] and its parts, its
//! [`CertificateAuthority`] and [`RunPolicy`](wildflowerhealthio_unit_runner::RunPolicy)
//! included, [`RegistryError`], the
//! failure vocabulary of the
//! [`ServerRegistry`](crate::ServerRegistry) port; enrolment: [`add_server`]
//! and [`set_server_credentials`], which check a tunnel's credentials with its
//! relay through the [`RelayClient`](crate::RelayClient) port before writing
//! the registry, and [`EnrolmentError`]; and changing a registered server:
//! [`set_run_policy`] with its [`RunPolicyChoice`], [`update_server`] and
//! [`remove_server`], with [`ServerChangeError`] and [`ServerUpdate`];
//! [`ServerDetail`], what a server's run reports to `UnitRunner`; launching a
//! server's launcher and its Authorization app: [`ensure_launchable`],
//! [`launch_url`], [`authorization_app_url`], [`sign_in_url`] and
//! [`LaunchError`], and opening the consent waiting on a server at its page,
//! [`consent_sign_in_url`]; [`PendingConsent`], the consent waiting on a
//! server, named by its [`ConsentKey`], and [`pending_consent_server_count`],
//! how many servers have one waiting; [`ServerStatus`], a server's
//! status on `UnitRunner` as the base receives it, with [`ServerStatusTracker`], and [`ListedServer`], a server as the
//! base lists it; and [`notifications`], what the host notifies about its
//! servers. Nothing here touches the network, and only [`remove_server`] the
//! filesystem, to delete the server's folder.

mod certificate_state_wire;
mod enrolment;
mod enrolment_error;
mod launch_error;
mod listed_server;
mod pending_consent;
mod pending_consent_count;
mod registry_error;
mod run_policy_choice;
mod server_change_error;
mod server_changes;
mod server_detail;
mod server_launch;
mod server_record;
mod server_status;

pub mod notifications;

pub use enrolment::{
    add_server, set_server_credentials, EnteredCredentials, EnteredRelay, RelayIdentity,
};
pub use enrolment_error::EnrolmentError;
pub use launch_error::LaunchError;
pub use listed_server::ListedServer;
pub use pending_consent::{ConsentKey, PendingConsent};
pub use pending_consent_count::pending_consent_server_count;
pub use registry_error::RegistryError;
pub use run_policy_choice::RunPolicyChoice;
pub use server_change_error::ServerChangeError;
pub use server_changes::{remove_server, set_run_policy, update_server, ServerUpdate};
pub use server_detail::ServerDetail;
pub use server_launch::{
    authorization_app_url, consent_sign_in_url, ensure_launchable, launch_url, sign_in_url,
};
pub use server_record::{RelayKind, ServerRecord, TunnelToken, SERVERS_DIR_NAME};
pub use server_status::{ServerStatus, ServerStatusTracker};
pub use wildflowerhealthio_wildflower_server::CertificateAuthority;

#[cfg(test)]
pub(crate) use server_record::tests as fixtures;
#[cfg(test)]
pub(crate) use server_status::tests::golden;
