//! Serde mirror of `RecorderBridge`'s save channel: `SaveHar` and its two
//! answers. The bridge's other tags are the sniffer's;
//! `browser-sniffer-tauri`'s tests (`open_matches_the_golden_file` and its
//! siblings) pin those against the same golden file.
//!
//! The TS schema in `apps/host/recorder/recorder-core-js/src/bridge.ts` is the
//! contract; `apps/host/recorder/recorder-wire-golden.json`, which the TS tests
//! read too, and the golden tests below are the drift guard. See the
//! [Wire Pinning How-To](../../../../../docs/Messaging/Wire%20Pinning%20How-To.md).

use serde::{Deserialize, Serialize};

/// Web→host tag literal, for routing an envelope `_tag` peek before
/// committing to a payload shape. Pinned to the serde representation of
/// [`RecorderWebToHost::SaveHar`] by this module's tag drift guard.
pub const SAVE_HAR: &str = "SaveHar";

/// Host→web tag literal for [`RecorderHostToWeb::HarSaved`].
pub const HAR_SAVED: &str = "HarSaved";

/// Host→web tag literal for [`RecorderHostToWeb::HarSaveFailed`].
pub const HAR_SAVE_FAILED: &str = "HarSaveFailed";

/// Every save-channel tag on the multiplexed bridge channel, in both
/// directions. The host's boot log reads from this list rather than its own.
pub const TAGS: [&str; 3] = [SAVE_HAR, HAR_SAVED, HAR_SAVE_FAILED];

/// Web→host messages on the recorder bridge's save channel.
///
/// Payload shape is pinned by the TS schema in
/// `apps/host/recorder/recorder-core-js/src/bridge.ts`: the web side
/// encodes against that schema, so the serde representation here must stay
/// byte-compatible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum RecorderWebToHost {
    /// Write this archive into the recordings folder.
    ///
    /// `file_name` is one path segment as `recordingFileName` produces it,
    /// re-validated by [`validate_file_name`][crate::save::validate_file_name]
    /// before any filesystem call. `text` is the `.har` file's already-encoded
    /// contents, not a nested object.
    ///
    /// Wire: `{"_tag":"SaveHar","fileName":"…","text":"…"}`.
    #[serde(rename_all = "camelCase")]
    SaveHar { file_name: String, text: String },
}

/// Host→web messages on the recorder bridge's save channel.
///
/// Payload shape is pinned by the TS schema in
/// `apps/host/recorder/recorder-core-js/src/bridge.ts`: the web side
/// validates inbound payloads against that schema, so the serde
/// representation here must stay byte-compatible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum RecorderHostToWeb {
    /// The archive was written, and `path` is where it landed. `file_name`
    /// echoes the request so the page can tell whose answer this is.
    ///
    /// Wire: `{"_tag":"HarSaved","fileName":"…","path":"/…/Wildflower Recordings/….har"}`.
    #[serde(rename_all = "camelCase")]
    HarSaved { file_name: String, path: String },
    /// Nothing was written, and `message` says why — a rejected file name or
    /// a failed write. Terminal either way: the page surfaces it, never
    /// retries.
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

    /// The `_tag` a message actually serializes with, read back out of the
    /// encoded JSON rather than restated as a second hand-written copy.
    fn encoded_tag(message: &impl Serialize) -> String {
        let encoded: Value = serde_json::to_value(message).expect("serialize");
        encoded
            .get("_tag")
            .and_then(Value::as_str)
            .expect("_tag")
            .to_owned()
    }

    /// The listener matches on these constants but decodes into the enums, so
    /// renaming either half alone would silently stop dispatching.
    #[test]
    fn tag_literals_match_the_serde_representation() {
        assert_eq!(
            encoded_tag(&RecorderWebToHost::SaveHar {
                file_name: "a.har".to_owned(),
                text: String::new(),
            }),
            SAVE_HAR
        );
        assert_eq!(
            encoded_tag(&RecorderHostToWeb::HarSaved {
                file_name: "a.har".to_owned(),
                path: "/tmp/a.har".to_owned(),
            }),
            HAR_SAVED
        );
        assert_eq!(
            encoded_tag(&RecorderHostToWeb::HarSaveFailed {
                file_name: "a.har".to_owned(),
                message: "nope".to_owned(),
            }),
            HAR_SAVE_FAILED
        );
        assert_eq!(TAGS, [SAVE_HAR, HAR_SAVED, HAR_SAVE_FAILED]);
    }

    /// Golden test: drift here is a cross-language protocol break, not a
    /// refactor.
    #[test]
    fn har_saved_serializes_to_pinned_wire_format() {
        let message = RecorderHostToWeb::HarSaved {
            file_name: "2026-01-02T03-04-05Z-example.test.har".to_owned(),
            path: "/home/u/Documents/Wildflower Recordings/2026-01-02T03-04-05Z-example.test.har"
                .to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"HarSaved","fileName":"2026-01-02T03-04-05Z-example.test.har","path":"/home/u/Documents/Wildflower Recordings/2026-01-02T03-04-05Z-example.test.har"}"#
        );
    }

    #[test]
    fn har_save_failed_serializes_to_pinned_wire_format() {
        let message = RecorderHostToWeb::HarSaveFailed {
            file_name: "a.har".to_owned(),
            message: "file name is not one path segment".to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&message).expect("serialize"),
            r#"{"_tag":"HarSaveFailed","fileName":"a.har","message":"file name is not one path segment"}"#
        );
    }

    /// The inbound direction: the exact string the TS side sends must decode,
    /// field renames included.
    #[test]
    fn save_har_deserializes_from_the_pinned_wire_format() {
        let decoded: RecorderWebToHost =
            serde_json::from_str(r#"{"_tag":"SaveHar","fileName":"a.har","text":"{\"log\":{}}"}"#)
                .expect("deserialize");
        assert_eq!(
            decoded,
            RecorderWebToHost::SaveHar {
                file_name: "a.har".to_owned(),
                text: r#"{"log":{}}"#.to_owned(),
            }
        );
    }

    /// The golden file both languages read: what the TS side sends must
    /// decode here, and what this side emits must equal what the TS side
    /// decodes.
    #[test]
    fn the_save_channel_matches_the_golden_file() {
        let golden: Value =
            serde_json::from_str(include_str!("../../recorder-wire-golden.json")).expect("golden");
        let save_har = &golden["webToHost"][SAVE_HAR];
        let decoded: RecorderWebToHost =
            serde_json::from_value(save_har.clone()).expect("SaveHar decodes");
        assert_eq!(
            serde_json::to_value(&decoded).expect("serialize"),
            *save_har
        );

        for tag in [HAR_SAVED, HAR_SAVE_FAILED] {
            let answer = &golden["hostToWeb"][tag];
            let decoded: RecorderHostToWeb =
                serde_json::from_value(answer.clone()).expect("answer decodes");
            assert_eq!(encoded_tag(&decoded), tag);
            assert_eq!(serde_json::to_value(&decoded).expect("serialize"), *answer);
        }
    }

    /// The listener peeks the envelope's `_tag` first and only then decodes
    /// the payload, so a sibling slice's message must not decode as ours.
    #[test]
    fn an_unknown_tag_fails_to_decode() {
        let error = serde_json::from_str::<RecorderWebToHost>(
            r#"{"_tag":"Open","fileName":"a.har","text":""}"#,
        );
        assert!(error.is_err(), "expected an unknown `_tag` to be rejected");
    }

    /// A `SaveHar` missing `text` must fail rather than half-decode into an
    /// empty archive.
    #[test]
    fn save_har_without_text_fails_to_decode() {
        let error =
            serde_json::from_str::<RecorderWebToHost>(r#"{"_tag":"SaveHar","fileName":"a.har"}"#);
        assert!(error.is_err(), "expected a missing `text` to be rejected");
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn save_har_round_trips(file_name in "[A-Za-z0-9._-]{1,40}", text in ".{0,200}") {
            let message = RecorderWebToHost::SaveHar { file_name, text };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: RecorderWebToHost =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }

        #[test]
        fn har_saved_round_trips(file_name in "[A-Za-z0-9._-]{1,40}", path in ".{1,120}") {
            let message = RecorderHostToWeb::HarSaved { file_name, path };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: RecorderHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }

        #[test]
        fn har_save_failed_round_trips(file_name in "[A-Za-z0-9._-]{1,40}", message in ".{0,200}") {
            let message = RecorderHostToWeb::HarSaveFailed { file_name, message };
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: RecorderHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }
    }
}
