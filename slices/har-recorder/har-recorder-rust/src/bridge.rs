//! Serde mirror of `HarRecorderBridge`, the recorder's save channel.
//!
//! The TS schema in
//! `slices/har-recorder/har-recorder-core/src/bridge.ts` is the contract;
//! the golden tests below are the drift guard. See the
//! [Wire Pinning How-To](../../../../docs/Messaging/Wire%20Pinning%20How-To.md).

use serde::{Deserialize, Serialize};

/// Web→host tag literal, for routing an envelope `_tag` peek before
/// committing to a payload shape. Pinned to the serde representation of
/// [`HarRecorderWebToHost::SaveHar`] by the tag drift guard in this
/// module's tests, so the literal and the enum cannot drift apart.
pub const SAVE_HAR: &str = "SaveHar";

/// Host→web tag literal for [`HarRecorderHostToWeb::HarSaved`].
pub const HAR_SAVED: &str = "HarSaved";

/// Host→web tag literal for [`HarRecorderHostToWeb::HarSaveFailed`].
pub const HAR_SAVE_FAILED: &str = "HarSaveFailed";

/// Every tag this slice dispatches on the multiplexed bridge channel, in
/// both directions — the one list the host's boot log reads from, so the
/// log cannot fall out of step with what the listener actually routes.
pub const TAGS: [&str; 3] = [SAVE_HAR, HAR_SAVED, HAR_SAVE_FAILED];

/// Web→host messages on the HAR recorder bridge.
///
/// Payload shape is pinned by the TS schema in
/// `slices/har-recorder/har-recorder-core/src/bridge.ts` — the web side
/// encodes against that schema, so the serde representation here must stay
/// byte-compatible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum HarRecorderWebToHost {
    /// Write this archive into the app's `saved_data` directory.
    ///
    /// `file_name` is one path segment as `recordingFileName` produces it;
    /// the host validates it again (see
    /// [`validate_file_name`][crate::save::validate_file_name]) before any
    /// filesystem call. `text` is the `.har` file's already-encoded
    /// contents, not a nested object — there is one HAR emitter, and it is
    /// on the web side.
    ///
    /// Wire: `{"_tag":"SaveHar","fileName":"…","text":"…"}`.
    #[serde(rename_all = "camelCase")]
    SaveHar { file_name: String, text: String },
}

/// Host→web messages on the HAR recorder bridge.
///
/// Payload shape is pinned by the TS schema in
/// `slices/har-recorder/har-recorder-core/src/bridge.ts` — the web side
/// validates inbound payloads against that schema, so the serde
/// representation here must stay byte-compatible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum HarRecorderHostToWeb {
    /// The archive was written, and `path` is where it landed. `file_name`
    /// echoes the request so a page that has since started another
    /// recording can tell whose answer this is.
    ///
    /// Wire: `{"_tag":"HarSaved","fileName":"…","path":"/…/saved_data/….har"}`.
    #[serde(rename_all = "camelCase")]
    HarSaved { file_name: String, path: String },
    /// Nothing was written, and `message` says why — a rejected file name
    /// or a failed write. Both are terminal: the recording's bytes live
    /// only in the page, so the page surfaces this rather than retrying.
    ///
    /// Wire: `{"_tag":"HarSaveFailed","fileName":"…","message":"…"}`.
    #[serde(rename_all = "camelCase")]
    HarSaveFailed { file_name: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::Value;

    /// The `_tag` a message actually serializes with — read back out of the
    /// encoded JSON rather than restated, so this derives from serde
    /// instead of from a second hand-written copy.
    fn encoded_tag(message: &impl Serialize) -> String {
        let encoded: Value = serde_json::to_value(message).expect("serialize");
        encoded
            .get("_tag")
            .and_then(Value::as_str)
            .expect("_tag")
            .to_owned()
    }

    /// Drift guard for the routing literals: the listener matches on these
    /// constants but decodes into the enums, so a rename of either half
    /// without the other would silently stop dispatching.
    #[test]
    fn tag_literals_match_the_serde_representation() {
        assert_eq!(
            encoded_tag(&HarRecorderWebToHost::SaveHar {
                file_name: "a.har".to_owned(),
                text: String::new(),
            }),
            SAVE_HAR
        );
        assert_eq!(
            encoded_tag(&HarRecorderHostToWeb::HarSaved {
                file_name: "a.har".to_owned(),
                path: "/tmp/a.har".to_owned(),
            }),
            HAR_SAVED
        );
        assert_eq!(
            encoded_tag(&HarRecorderHostToWeb::HarSaveFailed {
                file_name: "a.har".to_owned(),
                message: "nope".to_owned(),
            }),
            HAR_SAVE_FAILED
        );
        assert_eq!(TAGS, [SAVE_HAR, HAR_SAVED, HAR_SAVE_FAILED]);
    }

    /// Golden test: the wire shape is shared with the TS side, so any drift
    /// here is a cross-language protocol break, not a refactor.
    #[test]
    fn har_saved_serializes_to_pinned_wire_format() {
        let message = HarRecorderHostToWeb::HarSaved {
            file_name: "2026-01-02T03-04-05Z-example.test.har".to_owned(),
            path: "/home/u/saved_data/2026-01-02T03-04-05Z-example.test.har".to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"HarSaved","fileName":"2026-01-02T03-04-05Z-example.test.har","path":"/home/u/saved_data/2026-01-02T03-04-05Z-example.test.har"}"#
        );
    }

    #[test]
    fn har_save_failed_serializes_to_pinned_wire_format() {
        let message = HarRecorderHostToWeb::HarSaveFailed {
            file_name: "a.har".to_owned(),
            message: "file name is not one path segment".to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"HarSaveFailed","fileName":"a.har","message":"file name is not one path segment"}"#
        );
    }

    /// The inbound direction: the exact string the TSDoc documents must
    /// decode, field renames included.
    #[test]
    fn save_har_deserializes_from_the_pinned_wire_format() {
        let decoded: HarRecorderWebToHost =
            serde_json::from_str(r#"{"_tag":"SaveHar","fileName":"a.har","text":"{\"log\":{}}"}"#)
                .expect("deserialize");
        assert_eq!(
            decoded,
            HarRecorderWebToHost::SaveHar {
                file_name: "a.har".to_owned(),
                text: r#"{"log":{}}"#.to_owned(),
            }
        );
    }

    /// The listener peeks the envelope's `_tag` first and only then decodes
    /// the payload, so a sibling slice's message must not decode as ours.
    #[test]
    fn an_unknown_tag_fails_to_decode() {
        let error = serde_json::from_str::<HarRecorderWebToHost>(
            r#"{"_tag":"Open","fileName":"a.har","text":""}"#,
        );
        assert!(error.is_err(), "expected an unknown `_tag` to be rejected");
    }

    /// A `SaveHar` missing `text` is not half-decoded into an empty
    /// archive — it fails, and the host answers `HarSaveFailed`.
    #[test]
    fn save_har_without_text_fails_to_decode() {
        let error = serde_json::from_str::<HarRecorderWebToHost>(
            r#"{"_tag":"SaveHar","fileName":"a.har"}"#,
        );
        assert!(error.is_err(), "expected a missing `text` to be rejected");
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn save_har_round_trips(file_name in "[A-Za-z0-9._-]{1,40}", text in ".{0,200}") {
            let message = HarRecorderWebToHost::SaveHar { file_name, text };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: HarRecorderWebToHost =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }

        #[test]
        fn har_saved_round_trips(file_name in "[A-Za-z0-9._-]{1,40}", path in ".{1,120}") {
            let message = HarRecorderHostToWeb::HarSaved { file_name, path };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: HarRecorderHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }

        #[test]
        fn har_save_failed_round_trips(file_name in "[A-Za-z0-9._-]{1,40}", message in ".{0,200}") {
            let message = HarRecorderHostToWeb::HarSaveFailed { file_name, message };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: HarRecorderHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }
    }
}
