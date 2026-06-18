use serde::{Deserialize, Serialize};

/// Host→web messages on the gatekeeper bridge.
///
/// Payload shape is pinned by the TS schema in
/// `slices/gatekeeper/gatekeeper-core/src/bridge.ts` — the web side
/// validates inbound payloads against that schema's struct form, so the
/// serde representation here must stay byte-compatible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum GatekeeperHostToWeb {
    /// Notify-only signal that a fresh bearer is available for the
    /// embedded SPA to pull. The token does NOT ride this message —
    /// it is fetched out-of-band via a capability-gated Tauri
    /// command, so it never travels on the multiplexed bridge channel
    /// that sibling webviews can subscribe to.
    /// Wire: `{"_tag":"AuthTokenIssued"}`.
    AuthTokenIssued,
    /// Host informs the embedded SPA which (if any) pending device-flow
    /// authorization is currently first in line for owner consent. The
    /// SPA renders a non-dismissable modal whenever this is `Some` and
    /// hides it on `None`. `user_code` is the lookup key for the
    /// existing `useDeviceConsentQuery` / `/access/devices/{userCode}`
    /// fetch path — the popup uses the same data source as the
    /// standalone route.
    /// Wire: `{"_tag":"DeviceConsentRequested","userCode":"ABC-123"}`
    /// or `{"_tag":"DeviceConsentRequested","userCode":null}`.
    #[serde(rename_all = "camelCase")]
    DeviceConsentRequested { user_code: Option<String> },
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Golden test: the wire shape is shared with the TS side, so any
    /// drift here is a cross-language protocol break, not a refactor.
    #[test]
    fn auth_token_issued_serializes_to_pinned_wire_format() {
        let message = GatekeeperHostToWeb::AuthTokenIssued;
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"AuthTokenIssued"}"#
        );
    }

    #[test]
    fn auth_token_issued_round_trips() {
        let encoded =
            serde_json::to_string(&GatekeeperHostToWeb::AuthTokenIssued).expect("serialize");
        let decoded: GatekeeperHostToWeb = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, GatekeeperHostToWeb::AuthTokenIssued);
    }

    #[test]
    fn device_consent_requested_serializes_to_pinned_wire_format() {
        let some = GatekeeperHostToWeb::DeviceConsentRequested {
            user_code: Some("ABC-123".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&some).expect("serialize"),
            r#"{"_tag":"DeviceConsentRequested","userCode":"ABC-123"}"#
        );
        let none = GatekeeperHostToWeb::DeviceConsentRequested { user_code: None };
        assert_eq!(
            serde_json::to_string(&none).expect("serialize"),
            r#"{"_tag":"DeviceConsentRequested","userCode":null}"#
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn device_consent_requested_round_trips(user_code in prop::option::of("[A-Z0-9-]{1,16}")) {
            let message = GatekeeperHostToWeb::DeviceConsentRequested { user_code };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: GatekeeperHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }
    }
}
