//! [`RunningServerConsents`]: each running server's consents, by domain, which
//! its run puts in once its gatekeeper is set up and takes out when it ends;
//! and reading, approving and denying a consent through them, with the wire
//! shapes the base's commands answer in.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use gatekeeper_rust::domain::gatekeeper_error::GatekeeperError;
use gatekeeper_rust::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, ClientRegistrationVerdict, ConsentOutcome,
    DeviceConsentView, HostOwnerConsents, OAuthConsentView,
};
use parking_lot::Mutex;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use url::Url;

use crate::domain::ConsentKey;

/// The consents of the servers whose runs are up, keyed by domain.
///
/// A server's run puts its gatekeeper's [`HostOwnerConsents`] in with
/// [`Self::enter`] once the server is set up, and the
/// [`RunningServerConsentsEntry`] it holds takes them out when the run ends,
/// so a server that isn't running has none and every call on it is
/// [`ConsentError::ServerNotRunning`]. Clones share the one map.
///
/// [`Self::read`], [`Self::approve`] and [`Self::deny`] are each a
/// synchronous gatekeeper transaction: run them on a blocking thread.
#[derive(Clone, Default)]
pub struct RunningServerConsents {
    by_domain: Arc<Mutex<HashMap<String, Arc<HostOwnerConsents>>>>,
}

/// A run's place in [`RunningServerConsents`]: dropping it, as the run ends,
/// takes the run's consents out.
pub struct RunningServerConsentsEntry {
    running_server_consents: RunningServerConsents,
    domain: String,
    consents: Arc<HostOwnerConsents>,
}

impl Drop for RunningServerConsentsEntry {
    fn drop(&mut self) {
        let mut by_domain = self.running_server_consents.by_domain.lock();
        // Only this run's: a later run of the server holds its own entry.
        if by_domain
            .get(&self.domain)
            .is_some_and(|held| Arc::ptr_eq(held, &self.consents))
        {
            by_domain.remove(&self.domain);
        }
    }
}

impl RunningServerConsents {
    /// No server's consents.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Put the consents of the server `domain`'s run in, until the returned
    /// entry is dropped.
    #[must_use]
    pub fn enter(&self, domain: &str, consents: HostOwnerConsents) -> RunningServerConsentsEntry {
        let consents = Arc::new(consents);
        self.by_domain
            .lock()
            .insert(domain.to_owned(), Arc::clone(&consents));
        RunningServerConsentsEntry {
            running_server_consents: self.clone(),
            domain: domain.to_owned(),
            consents,
        }
    }

    fn of(&self, domain: &str) -> Result<Arc<HostOwnerConsents>, ConsentError> {
        self.by_domain
            .lock()
            .get(domain)
            .cloned()
            .ok_or_else(|| ConsentError::ServerNotRunning {
                domain: domain.to_owned(),
            })
    }

    /// The consent `consent` on the server `domain`, as the base shows it.
    ///
    /// # Errors
    ///
    /// [`ConsentError::ServerNotRunning`], [`ConsentError::NotPending`] when
    /// it has been answered or has expired, or the gatekeeper's failure.
    pub fn read(&self, domain: &str, consent: &ConsentKey) -> Result<ConsentDetails, ConsentError> {
        let consents = self.of(domain)?;
        Ok(match consent {
            ConsentKey::Device { user_code } => {
                ConsentDetails::of_device(user_code.clone(), consents.device_consent(user_code)?)
            }
            ConsentKey::OAuth { id } => ConsentDetails::of_oauth(consents.oauth_consent(id)?),
        })
    }

    /// Approve a consent on the server `domain` as `approval` says, at
    /// `now`, as the host's Owner.
    ///
    /// # Errors
    ///
    /// [`ConsentError::ServerNotRunning`], [`ConsentError::NotPending`],
    /// [`ConsentError::RegistrationNotAcknowledged`] for a new or widened
    /// app the approval doesn't acknowledge, or the gatekeeper's failure.
    pub fn approve(
        &self,
        domain: &str,
        approval: ConsentApproval,
        now: DateTime<Utc>,
    ) -> Result<ApprovalOutcome, ConsentError> {
        let consents = self.of(domain)?;
        let outcome = match approval {
            ConsentApproval::Device {
                user_code,
                approved_scopes,
                patient,
            } => consents.approve_device(
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
            } => consents.approve_oauth(
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

    /// Deny the consent `consent` on the server `domain`.
    ///
    /// # Errors
    ///
    /// [`ConsentError::ServerNotRunning`], [`ConsentError::NotPending`], or
    /// the gatekeeper's failure.
    pub fn deny(&self, domain: &str, consent: &ConsentKey) -> Result<(), ConsentError> {
        let consents = self.of(domain)?;
        match consent {
            ConsentKey::Device { user_code } => consents.deny_device(user_code)?,
            ConsentKey::OAuth { id } => consents.deny_oauth(id)?,
        }
        Ok(())
    }
}

/// A waiting consent as the base shows it, camelCase, `kind`-tagged as
/// [`ConsentKey`] is, each optional member left out when absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum ConsentDetails {
    /// A device asking to pair. It may be granted any of the scopes its
    /// client is registered for, not only the ones it asked for.
    #[serde(rename = "device", rename_all = "camelCase")]
    Device {
        user_code: String,
        client_id: String,
        /// The client's registered name, or its id when it has none.
        client_name: String,
        /// The name the device gave itself.
        #[serde(skip_serializing_if = "Option::is_none")]
        device_name: Option<String>,
        requested_scopes: Vec<String>,
        /// The scopes the client is registered for.
        allowed_scopes: Vec<String>,
    },
    /// An app's `/authorize`, waiting with the browser that opened it.
    #[serde(rename = "oauth", rename_all = "camelCase")]
    OAuth {
        id: String,
        client_id: String,
        /// The client's registered name, or its id when it has none.
        client_name: String,
        requested_scopes: Vec<String>,
        /// Where the app gets its answer: whose origin it is asking from.
        redirect_uri: Url,
        /// The patient a standing grant already names for the app.
        #[serde(skip_serializing_if = "Option::is_none")]
        patient: Option<String>,
        /// How the request compares with the app's registration.
        registration: Registration,
    },
}

impl ConsentDetails {
    /// The device request `user_code`, as the gatekeeper loaded it by that
    /// code.
    fn of_device(user_code: String, view: DeviceConsentView) -> Self {
        let DeviceConsentView {
            request,
            client_name,
            registered_client_scopes,
        } = view;
        Self::Device {
            user_code,
            client_id: request.client_id,
            client_name,
            device_name: request.device_name,
            requested_scopes: request.requested_scopes,
            allowed_scopes: registered_client_scopes,
        }
    }

    fn of_oauth(view: OAuthConsentView) -> Self {
        let OAuthConsentView {
            request,
            requested_redirect_uri,
            client_name,
            registration_verdict,
        } = view;
        Self::OAuth {
            id: request.id,
            client_id: request.client_id,
            client_name,
            requested_scopes: request.requested_scopes,
            redirect_uri: requested_redirect_uri,
            patient: request.patient,
            registration: registration_verdict.into(),
        }
    }
}

/// An authorization request against its app's registration, `status`-tagged:
/// `registered`, `new` for an app the server has never seen, or `changed`
/// when a known app's redirect or scopes step outside it. Approving a `new`
/// or `changed` request needs it acknowledged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Registration {
    Registered,
    New,
    #[serde(rename_all = "camelCase")]
    Changed {
        /// The redirect is on none of the app's registered redirects.
        redirect_uri_is_new: bool,
        /// The requested scopes the registration doesn't cover.
        new_scopes: Vec<String>,
    },
}

impl From<ClientRegistrationVerdict> for Registration {
    fn from(verdict: ClientRegistrationVerdict) -> Self {
        match verdict {
            ClientRegistrationVerdict::Registered => Self::Registered,
            ClientRegistrationVerdict::New => Self::New,
            ClientRegistrationVerdict::WouldWiden {
                redirect_uri_is_new,
                unregistered_requested_scopes,
            } => Self::Changed {
                redirect_uri_is_new,
                new_scopes: unregistered_requested_scopes,
            },
        }
    }
}

/// The Owner's approval of a consent, `kind`-tagged as [`ConsentKey`] is,
/// camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ConsentApproval {
    /// A device's pairing, with the scopes the Owner left ticked.
    #[serde(rename = "device", rename_all = "camelCase")]
    Device {
        user_code: String,
        approved_scopes: Vec<String>,
        patient: Option<String>,
    },
    /// An app's request, with the scopes the Owner left ticked and whether
    /// the Owner acknowledged a new or changed registration.
    #[serde(rename = "oauth", rename_all = "camelCase")]
    OAuth {
        id: String,
        approved_scopes: Vec<String>,
        patient: Option<String>,
        acknowledged_registration: bool,
    },
}

/// What an approval came to, `{"status": "approved" | "denied"}`: `denied`
/// when none of the approved scopes could be granted, which the gatekeeper
/// records as a denial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ApprovalOutcome {
    Approved,
    Denied,
}

/// Why a consent couldn't be read or decided. Serialises as
/// `{"kind", "message"}`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConsentError {
    /// The server isn't running, so its consents can't be reached.
    #[error("the server {domain} isn't running")]
    ServerNotRunning { domain: String },
    /// No consent with that key is waiting: it was answered elsewhere or
    /// expired.
    #[error("the request is no longer waiting: it was answered elsewhere or expired")]
    NotPending,
    /// The app is new to the server, or asks for more than it registered,
    /// and the approval didn't acknowledge it.
    #[error("the app is new or asks for more than it registered, so approving it needs that acknowledged")]
    RegistrationNotAcknowledged,
    /// Any other failure of the server's gatekeeper.
    #[error("the server's gatekeeper failed: {0}")]
    Gatekeeper(GatekeeperError),
}

impl ConsentError {
    /// The camelCase name the base branches on.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ServerNotRunning { .. } => "serverNotRunning",
            Self::NotPending => "notPending",
            Self::RegistrationNotAcknowledged => "registrationNotAcknowledged",
            Self::Gatekeeper(_) => "gatekeeper",
        }
    }
}

impl From<GatekeeperError> for ConsentError {
    fn from(error: GatekeeperError) -> Self {
        match error {
            GatekeeperError::DeviceConsentNotFound { .. }
            | GatekeeperError::OAuthConsentNotFound { .. } => Self::NotPending,
            GatekeeperError::RegistrationNotAcknowledged { .. } => {
                Self::RegistrationNotAcknowledged
            }
            other => Self::Gatekeeper(other),
        }
    }
}

impl Serialize for ConsentError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("ConsentError", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use gatekeeper_rust::domain::authorization_request::{
        AuthorizationRequest, GrantType, RequestStatus,
    };

    use super::*;
    use crate::domain::golden;

    fn request(id: &str, grant_type: GrantType, requested_scopes: &[&str]) -> AuthorizationRequest {
        let requested_at = Utc.with_ymd_and_hms(2026, 10, 8, 9, 0, 0).unwrap();
        AuthorizationRequest {
            id: id.to_owned(),
            grant_type,
            client_id: String::new(),
            requested_scopes: requested_scopes.iter().map(|s| (*s).to_owned()).collect(),
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: None,
            pre_approved_scopes: Vec::new(),
            requested_at,
            expires_at: requested_at + chrono::Duration::minutes(5),
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
            device_name: None,
            launch: None,
            launch_bound_patient: None,
        }
    }

    fn oauth(
        id: &str,
        client: (&str, &str),
        requested_scopes: &[&str],
        redirect_uri: &str,
        patient: Option<&str>,
        registration_verdict: ClientRegistrationVerdict,
    ) -> ConsentDetails {
        let mut request = request(id, GrantType::AuthorizationCode, requested_scopes);
        request.client_id = client.0.to_owned();
        request.patient = patient.map(ToOwned::to_owned);
        ConsentDetails::of_oauth(OAuthConsentView {
            request,
            requested_redirect_uri: Url::parse(redirect_uri).unwrap(),
            client_name: client.1.to_owned(),
            registration_verdict,
        })
    }

    #[test]
    fn the_details_are_as_the_golden_file_says() {
        let golden = golden();
        let mut device_request = request(
            "device-code",
            GrantType::DeviceCode,
            &["system/Observation.rs"],
        );
        device_request.client_id = "pebble-sync".to_owned();
        device_request.device_name = Some("Ruth's watch".to_owned());
        let details = [
            (
                "device",
                ConsentDetails::of_device(
                    "ABCD-EFGH".to_owned(),
                    DeviceConsentView {
                        request: device_request,
                        client_name: "Pebble sync".to_owned(),
                        registered_client_scopes: vec![
                            "system/Observation.rs".to_owned(),
                            "system/Patient.rs".to_owned(),
                        ],
                    },
                ),
            ),
            (
                "oauthRegistered",
                oauth(
                    "req-1",
                    ("lifting", "Lifting"),
                    &["launch/patient", "patient/Observation.rs"],
                    "https://lifting.example.com/callback",
                    Some("pat-1"),
                    ClientRegistrationVerdict::Registered,
                ),
            ),
            (
                "oauthNew",
                oauth(
                    "req-2",
                    (
                        "https://new.example.com/client",
                        "https://new.example.com/client",
                    ),
                    &["openid"],
                    "https://new.example.com/cb",
                    None,
                    ClientRegistrationVerdict::New,
                ),
            ),
            (
                "oauthChanged",
                oauth(
                    "req-3",
                    ("lifting", "Lifting"),
                    &["patient/Observation.rs", "patient/Condition.rs"],
                    "https://lifting.example.com/elsewhere",
                    None,
                    ClientRegistrationVerdict::WouldWiden {
                        redirect_uri_is_new: true,
                        unregistered_requested_scopes: vec!["patient/Condition.rs".to_owned()],
                    },
                ),
            ),
        ];
        for (name, details) in &details {
            assert_eq!(
                serde_json::to_value(details).unwrap(),
                golden["consentDetails"][name],
                "{name}"
            );
        }
        assert_eq!(
            golden["consentDetails"].as_object().unwrap().len(),
            details.len(),
            "every golden consent is checked"
        );
    }

    #[test]
    fn the_approvals_outcomes_and_errors_are_as_the_golden_file_says() {
        let golden = golden();
        assert_eq!(
            serde_json::from_value::<Vec<ConsentApproval>>(golden["consentApprovals"].clone())
                .unwrap(),
            [
                ConsentApproval::Device {
                    user_code: "ABCD-EFGH".to_owned(),
                    approved_scopes: vec!["system/Observation.rs".to_owned()],
                    patient: None,
                },
                ConsentApproval::OAuth {
                    id: "req-1".to_owned(),
                    approved_scopes: vec!["launch/patient".to_owned()],
                    patient: Some("pat-1".to_owned()),
                    acknowledged_registration: false,
                },
            ]
        );
        assert_eq!(
            serde_json::to_value([ApprovalOutcome::Approved, ApprovalOutcome::Denied]).unwrap(),
            golden["approvalOutcomes"]
        );
        let errors = [
            ConsentError::ServerNotRunning {
                domain: "ruth.relay.example.com".to_owned(),
            },
            ConsentError::NotPending,
            ConsentError::RegistrationNotAcknowledged,
        ];
        assert_eq!(
            serde_json::to_value(errors).unwrap(),
            golden["consentErrors"]
        );
    }

    #[test]
    fn an_approval_or_key_with_an_unknown_field_is_refused() {
        let approval = serde_json::json!({
            "kind": "oauth",
            "id": "req-1",
            "approvedScopes": [],
            "acknowledgedRegistration": false,
            "grantEverything": true,
        });
        assert!(serde_json::from_value::<ConsentApproval>(approval).is_err());
        let key = serde_json::json!({"kind": "device", "userCode": "A", "id": "B"});
        assert!(serde_json::from_value::<ConsentKey>(key).is_err());
    }

    #[test]
    fn the_gatekeeper_errors_the_base_branches_on_get_their_own_kind() {
        let cases = [
            (
                GatekeeperError::DeviceConsentNotFound {
                    user_code: "ABCD-EFGH".to_owned(),
                },
                "notPending",
            ),
            (
                GatekeeperError::OAuthConsentNotFound {
                    id: "req-1".to_owned(),
                },
                "notPending",
            ),
            (
                GatekeeperError::RegistrationNotAcknowledged {
                    id: "req-1".to_owned(),
                },
                "registrationNotAcknowledged",
            ),
            (
                GatekeeperError::infrastructure("reading a consent", "the database is locked"),
                "gatekeeper",
            ),
        ];
        for (gatekeeper_error, kind) in cases {
            assert_eq!(ConsentError::from(gatekeeper_error).kind(), kind);
        }
    }

    #[test]
    fn a_server_without_a_running_entry_is_not_running() {
        let consents = RunningServerConsents::new();
        let key = ConsentKey::OAuth {
            id: "req-1".to_owned(),
        };
        let not_running = ConsentError::ServerNotRunning {
            domain: "ruth.relay.example.com".to_owned(),
        };
        assert_eq!(
            consents.read("ruth.relay.example.com", &key),
            Err(not_running.clone())
        );
        assert_eq!(
            consents.deny("ruth.relay.example.com", &key),
            Err(not_running)
        );
    }
}
