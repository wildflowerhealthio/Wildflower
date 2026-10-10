//! [`ServerConsentDecider`]: a run's gatekeeper as the host reads, approves
//! and denies its consents, in the wire shapes the base's commands answer in.

use std::fmt;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use gatekeeper_rust::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, ConsentOutcome, HostConsentDecider,
};
use unit_runner_rust::{UnitId, UnitStatuses};

use crate::domain::{
    ApprovalOutcome, ConsentApproval, ConsentDetails, ConsentError, ConsentKey, ServerDetail,
};

/// Reads, approves and denies the consents waiting on one run of a server, as
/// the host's Owner, through the run's gatekeeper.
///
/// A run puts it in each [`ServerDetail`] it sets, and `UnitRunner` clears the
/// detail when the run ends, so [`Self::of_running_server`] finds one only
/// while the server's run is up. Clones share the run's gatekeeper, and two
/// are equal when they are the same run's.
///
/// [`Self::read`], [`Self::approve`] and [`Self::deny`] are each a
/// synchronous gatekeeper transaction: run them on a blocking thread. One that
/// started before the run ended finishes on that run's gatekeeper.
#[derive(Clone)]
pub struct ServerConsentDecider(Arc<HostConsentDecider>);

impl ServerConsentDecider {
    /// The decider over a run's gatekeeper, through its `decider`.
    #[must_use]
    pub fn new(decider: HostConsentDecider) -> Self {
        Self(Arc::new(decider))
    }

    /// The decider of the server `domain`'s run, from the servers' `statuses`.
    ///
    /// # Errors
    ///
    /// [`ConsentError::ServerNotRunning`] when no run of the server has set
    /// its detail.
    pub fn of_running_server(
        statuses: &UnitStatuses<ServerDetail>,
        domain: &str,
    ) -> Result<Self, ConsentError> {
        statuses
            .get(&UnitId::new(domain))
            .and_then(|status| status.detail.as_ref())
            .and_then(|detail| detail.consent_decider.clone())
            .ok_or_else(|| ConsentError::ServerNotRunning {
                domain: domain.to_owned(),
            })
    }

    /// The consent `consent`, as the base shows it.
    ///
    /// # Errors
    ///
    /// [`ConsentError::NotPending`] when it has been answered or has expired,
    /// or the gatekeeper's failure.
    pub fn read(&self, consent: &ConsentKey) -> Result<ConsentDetails, ConsentError> {
        Ok(match consent {
            ConsentKey::Device { user_code } => {
                ConsentDetails::of_device(user_code.clone(), self.0.device_consent(user_code)?)
            }
            ConsentKey::OAuth { id } => ConsentDetails::of_oauth(self.0.oauth_consent(id)?),
        })
    }

    /// Approve a consent as `approval` says, at `now`.
    ///
    /// # Errors
    ///
    /// [`ConsentError::NotPending`],
    /// [`ConsentError::RegistrationNotAcknowledged`] for a new or widened app
    /// the approval doesn't acknowledge, or the gatekeeper's failure.
    pub fn approve(
        &self,
        approval: ConsentApproval,
        now: DateTime<Utc>,
    ) -> Result<ApprovalOutcome, ConsentError> {
        let outcome = match approval {
            ConsentApproval::Device {
                user_code,
                approved_scopes,
                patient,
            } => self.0.approve_device(
                &user_code,
                ApproveDeviceConsentInput {
                    owner_approved_scopes: approved_scopes,
                    patient,
                    device_name: None,
                },
                now,
            )?,
            ConsentApproval::OAuth {
                id,
                approved_scopes,
                patient,
                acknowledged_registration,
            } => self.0.approve_oauth(
                &id,
                ApproveOAuthConsentInput {
                    owner_approved_scopes: approved_scopes,
                    patient,
                    acknowledged_registration,
                },
                now,
            )?,
        };
        Ok(match outcome {
            ConsentOutcome::Approved { .. } => ApprovalOutcome::Approved,
            ConsentOutcome::Denied => ApprovalOutcome::Denied,
        })
    }

    /// Deny the consent `consent`.
    ///
    /// # Errors
    ///
    /// [`ConsentError::NotPending`], or the gatekeeper's failure.
    pub fn deny(&self, consent: &ConsentKey) -> Result<(), ConsentError> {
        match consent {
            ConsentKey::Device { user_code } => self.0.deny_device(user_code)?,
            ConsentKey::OAuth { id } => self.0.deny_oauth(id)?,
        }
        Ok(())
    }
}

impl PartialEq for ServerConsentDecider {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ServerConsentDecider {}

impl fmt::Debug for ServerConsentDecider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerConsentDecider")
            .finish_non_exhaustive()
    }
}
