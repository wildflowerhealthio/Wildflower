use serde::{Deserialize, Serialize};

use crate::domain::pending_consent::PendingConsentHead;

/// Wire form of [`PendingConsentHead`] — the pending-consent queue head as the
/// SPA decodes it, `kind`-tagged.
///
/// A separate type from the domain enum on purpose: this one's serde attributes
/// *are* the cross-language contract (pinned by the golden tests below against
/// `gatekeeper-core/src/bridge.ts`), so they live beside those tests rather than
/// in `domain/`, where a rename would look like an ordinary refactor.
///
/// Wire: `{"kind":"device","userCode":"ABC-123"}` or `{"kind":"oauth","id":"…"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PendingConsentHeadWire {
    /// An RFC 8628 device-code request, keyed by its `user_code`.
    #[serde(rename_all = "camelCase")]
    Device { user_code: String },
    /// An RFC 6749 §4.1 authorization-code request parked by `/oauth/authorize`,
    /// keyed by the `AuthorizationRequest` id.
    OAuth { id: String },
}

/// Project the domain head onto the wire. The two enums are deliberately
/// one-to-one; adding a flow means adding both halves and a golden test.
impl From<PendingConsentHead> for PendingConsentHeadWire {
    fn from(head: PendingConsentHead) -> Self {
        match head {
            PendingConsentHead::Device { user_code } => {
                PendingConsentHeadWire::Device { user_code }
            }
            PendingConsentHead::OAuth { id } => PendingConsentHeadWire::OAuth { id },
        }
    }
}

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
    /// Host informs the embedded SPA which (if any) pending authorization
    /// request is currently first in line for owner consent — across both
    /// grant flows, since there is one popup slot. The SPA renders a modal
    /// whenever this is `Some` and hides it on `None`. The head carries only
    /// the lookup key for the existing `/access/devices/{userCode}` or
    /// `/access/oauth-consents/{id}` fetch, so the popup shares its data
    /// source with the standalone route for that flow.
    /// Wire: `{"_tag":"PendingConsentRequested","head":null}`,
    /// `{"_tag":"PendingConsentRequested","head":{"kind":"device","userCode":"ABC-123"}}`,
    /// or `{"_tag":"PendingConsentRequested","head":{"kind":"oauth","id":"req-1"}}`.
    PendingConsentRequested { head: Option<PendingConsentHeadWire> },
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

    /// Every optionality/variant form of the head has a pinned string: the
    /// cleared head, the device branch, and the code branch. An empty-vs-absent
    /// or `kind`-casing mismatch here breaks the SPA's decode outright.
    #[test]
    fn pending_consent_requested_serializes_to_pinned_wire_format() {
        let cleared = GatekeeperHostToWeb::PendingConsentRequested { head: None };
        assert_eq!(
            serde_json::to_string(&cleared).expect("serialize"),
            r#"{"_tag":"PendingConsentRequested","head":null}"#
        );

        let device = GatekeeperHostToWeb::PendingConsentRequested {
            head: Some(PendingConsentHeadWire::Device {
                user_code: "ABC-123".to_string(),
            }),
        };
        assert_eq!(
            serde_json::to_string(&device).expect("serialize"),
            r#"{"_tag":"PendingConsentRequested","head":{"kind":"device","userCode":"ABC-123"}}"#
        );

        let oauth = GatekeeperHostToWeb::PendingConsentRequested {
            head: Some(PendingConsentHeadWire::OAuth {
                id: "req-1".to_string(),
            }),
        };
        assert_eq!(
            serde_json::to_string(&oauth).expect("serialize"),
            r#"{"_tag":"PendingConsentRequested","head":{"kind":"oauth","id":"req-1"}}"#
        );
    }

    /// The domain → wire projection keeps each flow on its own branch: a
    /// `user_code` must never surface as an `id` (the SPA would fetch the wrong
    /// endpoint with a key it can't resolve).
    #[test]
    fn domain_head_projects_onto_the_matching_wire_branch() {
        assert_eq!(
            PendingConsentHeadWire::from(PendingConsentHead::Device {
                user_code: "ABC-123".to_string(),
            }),
            PendingConsentHeadWire::Device {
                user_code: "ABC-123".to_string(),
            }
        );
        assert_eq!(
            PendingConsentHeadWire::from(PendingConsentHead::OAuth {
                id: "req-1".to_string(),
            }),
            PendingConsentHeadWire::OAuth {
                id: "req-1".to_string(),
            }
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn pending_consent_requested_round_trips(
            head in prop::option::of(prop_oneof![
                "[A-Z0-9-]{1,16}".prop_map(|user_code| PendingConsentHeadWire::Device { user_code }),
                "[a-z0-9-]{1,36}".prop_map(|id| PendingConsentHeadWire::OAuth { id }),
            ])
        ) {
            let message = GatekeeperHostToWeb::PendingConsentRequested { head };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: GatekeeperHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }
    }
}
