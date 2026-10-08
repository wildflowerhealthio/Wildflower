//! [`ConsentDetails`], a waiting consent as the base shows it, with its
//! [`Registration`].

use gatekeeper_rust::{ClientRegistrationVerdict, DeviceConsentView, OAuthConsentView};
use serde::Serialize;
use url::Url;

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
        registered_scopes: Vec<String>,
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
    pub(crate) fn of_device(user_code: String, view: DeviceConsentView) -> Self {
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
            registered_scopes: registered_client_scopes,
        }
    }

    pub(crate) fn of_oauth(view: OAuthConsentView) -> Self {
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

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
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
}
