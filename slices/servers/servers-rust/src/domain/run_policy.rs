//! [`RunPolicy`]: when the user wants a server run, as the record stores it,
//! and [`RunPolicyChoice`], what the user picks to set it.
//!
//! A policy is **active** while it says the server should run:
//! [`RunPolicy::Always`], [`RunPolicy::WhileInUse`], and a
//! [`RunPolicy::Until`] whose `at` is still ahead. An `Until` whose `at` has
//! passed stays in the record as it is; nothing rewrites it when the deadline
//! passes, it only stops counting as active. Only the user's choices write a
//! policy.

use chrono::{DateTime, Datelike, TimeDelta, Utc};
use serde::{Deserialize, Serialize};

use crate::domain::ServerChangeError;

/// When the user wants a server run.
///
/// Serialised as `{"kind": "off"}`, `{"kind": "whileInUse"}`,
/// `{"kind": "until", "at": "<RFC 3339 UTC>"}` or `{"kind": "always"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RunPolicy {
    /// Never run.
    Off,
    /// Run while the app is in use. The host has no in-use tracking yet, so
    /// for now it runs while the app's process is alive.
    WhileInUse,
    /// Run until `at`, whether or not the app is in use.
    Until {
        /// When the window ends, in UTC.
        at: DateTime<Utc>,
    },
    /// Always run.
    Always,
}

impl RunPolicy {
    /// Whether the policy says the server should run at `now`: `Always`,
    /// `WhileInUse`, or an `Until` whose `at` is after `now`.
    #[must_use]
    pub fn is_active_at(&self, now: DateTime<Utc>) -> bool {
        match self {
            Self::Off => false,
            Self::WhileInUse | Self::Always => true,
            Self::Until { at } => *at > now,
        }
    }
}

/// The last year a [`RunPolicy::Until`] deadline can fall in: RFC 3339's
/// four-digit years, the last the base's date-time decoder reads.
const LATEST_DEADLINE_YEAR: i32 = 9999;

/// The policy the user picks for a server: [`RunPolicy`] with the window
/// given as a duration from now rather than a deadline.
///
/// Deserialised from `{"kind": "off"}`, `{"kind": "whileInUse"}`,
/// `{"kind": "for", "seconds": <integer>}` or `{"kind": "always"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RunPolicyChoice {
    Off,
    WhileInUse,
    /// Run for `seconds` from the moment the choice is applied, stored as a
    /// [`RunPolicy::Until`]. Choosing it again counts from then, not from the
    /// current deadline.
    For {
        seconds: i64,
    },
    Always,
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
            Self::WhileInUse => RunPolicy::WhileInUse,
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
    fn a_policy_is_active_unless_off_or_past_its_deadline() {
        let now = now();
        assert!(!RunPolicy::Off.is_active_at(now));
        assert!(RunPolicy::WhileInUse.is_active_at(now));
        assert!(RunPolicy::Always.is_active_at(now));
        assert!(RunPolicy::Until {
            at: now + TimeDelta::seconds(1)
        }
        .is_active_at(now));
        assert!(!RunPolicy::Until { at: now }.is_active_at(now));
        assert!(!RunPolicy::Until {
            at: now - TimeDelta::hours(2)
        }
        .is_active_at(now));
    }

    #[test]
    fn a_policy_serialises_camel_case_by_kind() {
        for (policy, json) in [
            (RunPolicy::Off, serde_json::json!({"kind": "off"})),
            (
                RunPolicy::WhileInUse,
                serde_json::json!({"kind": "whileInUse"}),
            ),
            (
                RunPolicy::Until { at: now() },
                serde_json::json!({"kind": "until", "at": "2026-10-06T17:00:00Z"}),
            ),
            (RunPolicy::Always, serde_json::json!({"kind": "always"})),
        ] {
            assert_eq!(serde_json::to_value(policy).unwrap(), json);
            assert_eq!(serde_json::from_value::<RunPolicy>(json).unwrap(), policy);
        }
        for json in [
            serde_json::json!({"kind": "while_in_use"}),
            serde_json::json!({"kind": "until"}),
            serde_json::json!({"kind": "until", "at": "tomorrow"}),
        ] {
            assert!(
                serde_json::from_value::<RunPolicy>(json.clone()).is_err(),
                "{json}"
            );
        }
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
            (RunPolicyChoice::WhileInUse, RunPolicy::WhileInUse),
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
                serde_json::json!({"kind": "whileInUse"}),
                RunPolicyChoice::WhileInUse,
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
            serde_json::json!({"kind": "for"}),
            serde_json::json!({"kind": "for", "seconds": 1.5}),
        ] {
            assert!(
                serde_json::from_value::<RunPolicyChoice>(json.clone()).is_err(),
                "{json}"
            );
        }
    }
}
