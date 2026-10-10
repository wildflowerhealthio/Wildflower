//! [`RunPolicyChoice`]: the run policy the user picks for a server, which
//! becomes the [`RunPolicy`] its record stores.
//!
//! [`RunPolicy`] is `UnitRunner`'s own type, stored in `servers.json` in its
//! wire shape. An `Until` whose `at` has passed stays in the record as it is;
//! nothing rewrites it when the deadline passes, it only stops wanting its
//! server running. Only the user's choices write a policy.

use chrono::{DateTime, Datelike, TimeDelta, Utc};
use serde::Deserialize;
use unit_runner_rust::RunPolicy;

use crate::domain::ServerChangeError;

/// The last year a [`RunPolicy::Until`] deadline can fall in: RFC 3339's
/// four-digit years, the last the base's date-time decoder reads.
const LATEST_DEADLINE_YEAR: i32 = 9999;

/// The policy the user picks for a server: [`RunPolicy`] with the window
/// given as a duration from now rather than a deadline.
///
/// Deserialised from `{"kind": "off"}`, `{"kind": "whileOpen"}`,
/// `{"kind": "for", "seconds": <integer>}` or `{"kind": "always"}`.
///
/// Decoding refuses an unknown kind, an unknown field, a `seconds` on any
/// kind but `for`, and a `for` without one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "RunPolicyChoiceWire")]
pub enum RunPolicyChoice {
    /// [`RunPolicy::Off`]: never run.
    Off,
    /// [`RunPolicy::WhileOpen`]: run while the app is present, and for
    /// `UnitRunner`'s grace period after it becomes absent.
    WhileOpen,
    /// Run for `seconds` from the moment the choice is applied, stored as a
    /// [`RunPolicy::Until`]. Choosing it again counts from then, not from the
    /// current deadline.
    For {
        /// How long to run for, from the moment the choice is applied.
        seconds: i64,
    },
    /// [`RunPolicy::Always`]: always run.
    Always,
}

/// [`RunPolicyChoice`]'s wire shape: serde's internally tagged enums accept
/// unknown fields on unit variants even with `deny_unknown_fields`, so the
/// shape is a flat struct, checked on the way in, as `UnitRunner`'s
/// `RunPolicy` is.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunPolicyChoiceWire {
    kind: RunPolicyChoiceKind,
    #[serde(default)]
    seconds: Option<i64>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RunPolicyChoiceKind {
    Off,
    WhileOpen,
    For,
    Always,
}

impl TryFrom<RunPolicyChoiceWire> for RunPolicyChoice {
    type Error = String;

    fn try_from(wire: RunPolicyChoiceWire) -> Result<Self, Self::Error> {
        match (wire.kind, wire.seconds) {
            (RunPolicyChoiceKind::Off, None) => Ok(Self::Off),
            (RunPolicyChoiceKind::WhileOpen, None) => Ok(Self::WhileOpen),
            (RunPolicyChoiceKind::For, Some(seconds)) => Ok(Self::For { seconds }),
            (RunPolicyChoiceKind::Always, None) => Ok(Self::Always),
            (RunPolicyChoiceKind::For, None) => {
                Err("a `for` run policy choice needs `seconds`".to_owned())
            }
            (
                RunPolicyChoiceKind::Off
                | RunPolicyChoiceKind::WhileOpen
                | RunPolicyChoiceKind::Always,
                Some(_),
            ) => Err("only a `for` run policy choice has `seconds`".to_owned()),
        }
    }
}

impl RunPolicyChoice {
    /// The [`RunPolicy`] this choice stores when applied at `now`: `For` is
    /// `Until { at: now + seconds }`, the rest are themselves.
    ///
    /// # Errors
    ///
    /// [`ServerChangeError::NonPositiveDuration`] for a `For` of zero seconds
    /// or less, and [`ServerChangeError::DurationOutOfRange`] for one whose
    /// deadline is after the year 9999.
    pub fn into_run_policy_at(self, now: DateTime<Utc>) -> Result<RunPolicy, ServerChangeError> {
        Ok(match self {
            Self::Off => RunPolicy::Off,
            Self::WhileOpen => RunPolicy::WhileOpen,
            Self::Always => RunPolicy::Always,
            Self::For { seconds } => {
                if seconds <= 0 {
                    return Err(ServerChangeError::NonPositiveDuration { seconds });
                }
                let at = TimeDelta::try_seconds(seconds)
                    .and_then(|duration| now.checked_add_signed(duration))
                    .filter(|at| at.year() <= LATEST_DEADLINE_YEAR)
                    .ok_or(ServerChangeError::DurationOutOfRange { seconds })?;
                RunPolicy::Until { at }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 6, 17, 0, 0).unwrap()
    }

    #[test]
    fn for_is_stored_as_until_now_plus_its_seconds() {
        assert_eq!(
            RunPolicyChoice::For { seconds: 1800 }
                .into_run_policy_at(now())
                .unwrap(),
            RunPolicy::Until {
                at: Utc.with_ymd_and_hms(2026, 10, 6, 17, 30, 0).unwrap()
            }
        );
    }

    #[test]
    fn the_other_choices_are_their_own_policy() {
        for (choice, policy) in [
            (RunPolicyChoice::Off, RunPolicy::Off),
            (RunPolicyChoice::WhileOpen, RunPolicy::WhileOpen),
            (RunPolicyChoice::Always, RunPolicy::Always),
        ] {
            assert_eq!(choice.into_run_policy_at(now()).unwrap(), policy);
        }
    }

    #[test]
    fn a_duration_of_zero_or_less_is_rejected() {
        for seconds in [0, -1, i64::MIN] {
            assert!(
                matches!(
                    RunPolicyChoice::For { seconds }.into_run_policy_at(now()),
                    Err(ServerChangeError::NonPositiveDuration { seconds: rejected }) if rejected == seconds
                ),
                "{seconds}"
            );
        }
    }

    #[test]
    fn a_duration_past_the_latest_deadline_is_rejected() {
        let to_last_second_of_9999 =
            (Utc.with_ymd_and_hms(9999, 12, 31, 23, 59, 59).unwrap() - now()).num_seconds();
        assert!(RunPolicyChoice::For {
            seconds: to_last_second_of_9999
        }
        .into_run_policy_at(now())
        .is_ok());
        // Past year 9999 the deadline would serialise as `+10000-…`, which the
        // base's date-time decoder refuses; past chrono's range it can't be held.
        for seconds in [to_last_second_of_9999 + 1, 1_000_000_000_000, i64::MAX] {
            assert!(
                matches!(
                    RunPolicyChoice::For { seconds }.into_run_policy_at(now()),
                    Err(ServerChangeError::DurationOutOfRange { seconds: rejected }) if rejected == seconds
                ),
                "{seconds}"
            );
        }
    }

    #[test]
    fn a_choice_decodes_from_camel_case_json() {
        for (json, choice) in [
            (serde_json::json!({"kind": "off"}), RunPolicyChoice::Off),
            (
                serde_json::json!({"kind": "whileOpen"}),
                RunPolicyChoice::WhileOpen,
            ),
            (
                serde_json::json!({"kind": "for", "seconds": 7200}),
                RunPolicyChoice::For { seconds: 7200 },
            ),
            (
                serde_json::json!({"kind": "always"}),
                RunPolicyChoice::Always,
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<RunPolicyChoice>(json).unwrap(),
                choice
            );
        }
        for json in [
            serde_json::json!({"kind": "until", "at": "2026-10-06T17:00:00Z"}),
            serde_json::json!({"kind": "whileInUse"}),
            serde_json::json!({"kind": "sometimes"}),
            serde_json::json!({"kind": "for"}),
            serde_json::json!({"kind": "for", "seconds": null}),
            serde_json::json!({"kind": "for", "seconds": 1.5}),
            serde_json::json!({"kind": "for", "seconds": "60"}),
            serde_json::json!({"kind": "for", "seconds": 60, "by": "me"}),
            serde_json::json!({"kind": "always", "seconds": 60}),
            serde_json::json!({"kind": "off", "seconds": 60}),
            serde_json::json!({"kind": "whileOpen", "seconds": 60}),
            serde_json::json!({"kind": "off", "by": "me"}),
            serde_json::json!({"kind": "always", "at": "2026-10-06T17:00:00Z"}),
            serde_json::json!({"seconds": 60}),
            serde_json::json!("always"),
        ] {
            assert!(
                serde_json::from_value::<RunPolicyChoice>(json.clone()).is_err(),
                "{json}"
            );
        }
    }
}
