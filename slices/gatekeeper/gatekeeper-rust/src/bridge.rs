use serde::{Deserialize, Serialize};

/// Host→web messages on the gatekeeper bridge.
///
/// Payload shape is pinned by the TS schema in
/// `slices/gatekeeper/gatekeeper-core/src/bridge.ts` — the web side
/// validates inbound payloads against that schema's struct form, so the
/// serde representation here must stay byte-compatible:
/// `{"_tag":"AuthTokenIssued","token":"..."}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum GatekeeperHostToWeb {
    /// Host hands a bearer token to the embedded SPA so HTTP calls to the
    /// gatekeeper API authenticate.
    AuthTokenIssued { token: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Golden test: the wire shape is shared with the TS side, so any
    /// drift here is a cross-language protocol break, not a refactor.
    #[test]
    fn auth_token_issued_serializes_to_pinned_wire_format() {
        let message = GatekeeperHostToWeb::AuthTokenIssued {
            token: "abc".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"AuthTokenIssued","token":"abc"}"#
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn auth_token_issued_round_trips(token in ".{0,256}") {
            let message = GatekeeperHostToWeb::AuthTokenIssued { token };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: GatekeeperHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }
    }
}
