//! The servers domain: [`ServerRecord`] and its parts, its
//! [`CertificateAuthority`] and [`RunPolicy`](unit_runner::RunPolicy)
//! included, [`RegistryError`], the
//! failure vocabulary of the
//! [`ServerRegistry`](crate::ServerRegistry) port; enrolment: [`add_server`]
//! and [`set_server_credentials`], which check a tunnel's credentials with its
//! relay through the [`RelayClient`](crate::RelayClient) port before writing
//! the registry, and [`EnrolmentError`]; and changing a registered server:
//! [`set_run_policy`] with its [`RunPolicyChoice`], [`update_server`] and
//! [`remove_server`], with [`ServerChangeError`] and [`ServerUpdate`];
//! [`ServerDetail`], what a server's run reports to `UnitRunner`; launching a
//! server's launcher: [`ensure_launchable`], [`launch_url`] and
//! [`LaunchError`];
//! [`PendingConsent`], the consent waiting on a server, named by its
//! [`ConsentKey`], with [`PendingConsentTracker`]; the consent commands' wire
//! shapes: [`ConsentDetails`] with its [`Registration`], [`ConsentApproval`],
//! [`ApprovalOutcome`] and [`ConsentError`]; [`ServerStatus`], a server's
//! status on `UnitRunner` as the base receives it, with [`ServerStatusTracker`], and [`ListedServer`], a server as the
//! base lists it; and [`notifications`], what the host notifies about its
//! servers. Nothing here touches the network, and only [`remove_server`] the
//! filesystem, to delete the server's folder.

mod certificate_state_wire;
mod consent_approval;
mod consent_details;
mod consent_error;
mod enrolment;
mod enrolment_error;
mod launch_error;
mod listed_server;
mod pending_consent;
mod registry_error;
mod run_policy_choice;
mod server_change_error;
mod server_changes;
mod server_detail;
mod server_launch;
mod server_record;
mod server_status;

pub mod notifications;

pub use consent_approval::{ApprovalOutcome, ConsentApproval};
pub use consent_details::{ConsentDetails, Registration};
pub use consent_error::ConsentError;
pub use enrolment::{add_server, set_server_credentials, EnteredRelay, RelayIdentity};
pub use enrolment_error::EnrolmentError;
pub use launch_error::LaunchError;
pub use listed_server::ListedServer;
pub use pending_consent::{
    ConsentKey, PendingConsent, PendingConsentChange, PendingConsentTracker,
};
pub use registry_error::RegistryError;
pub use run_policy_choice::RunPolicyChoice;
pub use server_change_error::ServerChangeError;
pub use server_changes::{remove_server, set_run_policy, update_server, ServerUpdate};
pub use server_detail::ServerDetail;
pub use server_launch::{ensure_launchable, launch_url};
pub use server_record::{RelayKind, ServerRecord, TunnelToken, SERVERS_DIR_NAME};
pub use server_status::{ServerStatus, ServerStatusTracker};
pub use wildflower_server_rust::CertificateAuthority;

#[cfg(test)]
pub(crate) use server_record::tests as fixtures;
#[cfg(test)]
pub(crate) use server_status::tests::golden;
