//! [`RunPolicy`], when the app wants a unit to run, and the instant each policy
//! is active at.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// When the app wants a unit to run.
///
/// The app stores it and pushes it to the runner; the runner never changes it.
/// An expired `Until` stays exactly as the app set it.
///
/// Wire: `{"kind":"off"}`, `{"kind":"whileInUse"}`,
/// `{"kind":"until","at":"2026-10-06T17:00:00Z"}`, `{"kind":"always"}`.
///
/// Decoding refuses an unknown kind, an unknown field, an `at` on any kind but
/// `until`, and an `until` without one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "RunPolicyWire", into = "RunPolicyWire")]
pub enum RunPolicy {
    /// Never run.
    Off,
    /// Run while the app is in use, and for
    /// [`WHILE_IN_USE_GRACE`](crate::WHILE_IN_USE_GRACE) after it stops being in
    /// use.
    WhileInUse,
    /// Run while `at` is ahead of the wall clock.
    Until {
        /// The wall-clock instant the policy stops being active.
        at: DateTime<Utc>,
    },
    /// Always run.
    Always,
}

/// [`RunPolicy`]'s wire shape: serde's internally tagged enums accept unknown
/// fields on unit variants even with `deny_unknown_fields`, so the shape is a
/// flat struct, checked on the way in.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunPolicyWire {
    kind: RunPolicyKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RunPolicyKind {
    Off,
    WhileInUse,
    Until,
    Always,
}

impl TryFrom<RunPolicyWire> for RunPolicy {
    type Error = String;

    fn try_from(wire: RunPolicyWire) -> Result<Self, Self::Error> {
        match (wire.kind, wire.at) {
            (RunPolicyKind::Off, None) => Ok(Self::Off),
            (RunPolicyKind::WhileInUse, None) => Ok(Self::WhileInUse),
            (RunPolicyKind::Until, Some(at)) => Ok(Self::Until { at }),
            (RunPolicyKind::Always, None) => Ok(Self::Always),
            (RunPolicyKind::Until, None) => Err("an `until` run policy needs `at`".to_owned()),
            (RunPolicyKind::Off | RunPolicyKind::WhileInUse | RunPolicyKind::Always, Some(_)) => {
                Err("only an `until` run policy has `at`".to_owned())
            }
        }
    }
}

impl From<RunPolicy> for RunPolicyWire {
    fn from(policy: RunPolicy) -> Self {
        let (kind, at) = match policy {
            RunPolicy::Off => (RunPolicyKind::Off, None),
            RunPolicy::WhileInUse => (RunPolicyKind::WhileInUse, None),
            RunPolicy::Until { at } => (RunPolicyKind::Until, Some(at)),
            RunPolicy::Always => (RunPolicyKind::Always, None),
        };
        Self { kind, at }
    }
}

impl RunPolicy {
    /// Whether the policy is active at the wall-clock instant `now`.
    ///
    /// `app_in_use_or_in_grace` is whether the app is in use or still within the
    /// grace period after it stopped being in use; only `WhileInUse` reads it.
    #[must_use]
    pub fn is_active(&self, now: DateTime<Utc>, app_in_use_or_in_grace: bool) -> bool {
        match self {
            Self::Off => false,
            Self::WhileInUse => app_in_use_or_in_grace,
            Self::Until { at } => now < *at,
            Self::Always => true,
        }
    }

    /// The wall-clock instant after `now` at which the policy stops being
    /// active on its own, so the runner can reconcile then: an `Until` that is
    /// still ahead. `WhileInUse`'s end is the grace period's, which the app's
    /// use decides.
    #[must_use]
    pub fn expires_after(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Self::Until { at } if now < *at => Some(*at),
            Self::Off | Self::WhileInUse | Self::Until { .. } | Self::Always => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeDelta;
    use proptest::prelude::*;

    fn instant(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).expect("a valid instant")
    }

    #[test]
    fn off_and_always_ignore_the_clock_and_the_app_s_use() {
        for in_use in [false, true] {
            assert!(!RunPolicy::Off.is_active(instant(0), in_use));
            assert!(RunPolicy::Always.is_active(instant(0), in_use));
        }
    }

    #[test]
    fn while_in_use_follows_the_app_s_use() {
        assert!(RunPolicy::WhileInUse.is_active(instant(0), true));
        assert!(!RunPolicy::WhileInUse.is_active(instant(0), false));
    }

    #[test]
    fn until_is_active_strictly_before_its_instant() {
        let policy = RunPolicy::Until { at: instant(10) };
        assert!(policy.is_active(instant(9), false));
        assert!(!policy.is_active(instant(10), true));
        assert!(!policy.is_active(instant(11), true));
        assert_eq!(policy.expires_after(instant(9)), Some(instant(10)));
        assert_eq!(policy.expires_after(instant(10)), None);
    }

    #[test]
    fn the_wire_shape_is_kind_tagged_camel_case() {
        let cases = [
            (RunPolicy::Off, r#"{"kind":"off"}"#),
            (RunPolicy::WhileInUse, r#"{"kind":"whileInUse"}"#),
            (
                RunPolicy::Until {
                    at: DateTime::parse_from_rfc3339("2026-10-06T17:00:00Z")
                        .expect("parse")
                        .with_timezone(&Utc),
                },
                r#"{"kind":"until","at":"2026-10-06T17:00:00Z"}"#,
            ),
            (RunPolicy::Always, r#"{"kind":"always"}"#),
        ];
        for (policy, wire) in cases {
            assert_eq!(serde_json::to_string(&policy).expect("serialize"), wire);
            assert_eq!(
                serde_json::from_str::<RunPolicy>(wire).expect("deserialize"),
                policy
            );
        }
    }

    #[test]
    fn an_until_in_another_offset_decodes_to_the_same_instant() {
        let decoded: RunPolicy =
            serde_json::from_str(r#"{"kind":"until","at":"2026-10-06T19:00:00+02:00"}"#)
                .expect("deserialize");
        assert_eq!(
            serde_json::to_string(&decoded).expect("serialize"),
            r#"{"kind":"until","at":"2026-10-06T17:00:00Z"}"#
        );
    }

    #[test]
    fn unknown_kinds_and_fields_are_refused() {
        for wire in [
            r#"{"kind":"sometimes"}"#,
            r#"{"kind":"always","at":"2026-10-06T17:00:00Z"}"#,
            r#"{"kind":"off","by":"me"}"#,
            r#"{"kind":"whileInUse","at":null,"x":1}"#,
            r#"{"kind":"until","at":"2026-10-06T17:00:00Z","by":"me"}"#,
            r#"{"kind":"until"}"#,
            r#"{"kind":"until","at":"tomorrow"}"#,
            r#"{"at":"2026-10-06T17:00:00Z"}"#,
            r#""always""#,
        ] {
            assert!(
                serde_json::from_str::<RunPolicy>(wire).is_err(),
                "{wire} must not decode"
            );
        }
    }

    proptest! {
        /// Every `Until` round-trips through its wire shape, whatever its
        /// instant, to the microsecond and beyond.
        #[test]
        fn until_round_trips(seconds in -10_000_000_000_i64..10_000_000_000, nanos in 0_u32..1_000_000_000) {
            let at = DateTime::from_timestamp(seconds, nanos).expect("a valid instant");
            let policy = RunPolicy::Until { at };
            let wire = serde_json::to_string(&policy).expect("serialize");
            prop_assert_eq!(serde_json::from_str::<RunPolicy>(&wire).expect("deserialize"), policy);
        }

        /// An `Until` is active exactly while its instant is ahead, whatever the
        /// app's use, and its expiry is reported exactly then.
        #[test]
        fn until_is_active_exactly_while_ahead(offset in -1_000_i64..1_000, in_use: bool) {
            let at = instant(0);
            let now = at + TimeDelta::seconds(offset);
            let policy = RunPolicy::Until { at };
            prop_assert_eq!(policy.is_active(now, in_use), offset < 0);
            prop_assert_eq!(policy.expires_after(now).is_some(), offset < 0);
        }
    }
}
