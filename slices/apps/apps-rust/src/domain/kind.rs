//! [`AppKind`] — the discriminator: which per-kind configuration table
//! (`system_app_configurations` / `cloud_app_configurations` /
//! `self_hosted_app_configurations`) holds a registration's payload row. It is the
//! `app_registrations.kind` column value, the
//! `GET /apps` wire discriminator, and the kind an [`AppConfiguration`](super::AppConfiguration)
//! reports via [`AppConfiguration::kind`](super::AppConfiguration::kind) and the
//! launch / delete seams dispatch on. Replaces the former `Provenance` (renamed
//! slice-wide to free *provenance*
//! for the launch path's unrelated `RequestProvenance`). The taxonomy and privacy
//! model are canonical in `docs/Apps/Explanation.md`.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Which kind an app is — the discriminator. Serialized as its kebab string
/// (`"system"` / `"self-hosted"` / `"cloud"`), the same value stored in the
/// `CHECK`-constrained `app_registrations.kind` column and sent on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AppKind {
    /// A compiled-shell route
    /// ([`SystemAppConfiguration`](super::SystemAppConfiguration),
    /// `system_app_configurations`).
    System,
    /// A locally-served app on a dedicated loopback `port`
    /// (`self_hosted_app_configurations`).
    SelfHosted,
    /// A remote launch template reaching PHI through the tunnel
    /// (`cloud_app_configurations`).
    Cloud,
}

impl AppKind {
    /// The canonical kebab string — the `app_registrations.kind` value the store
    /// reads
    /// and writes, and the single source of truth for [`fmt::Display`].
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            AppKind::System => "system",
            AppKind::SelfHosted => "self-hosted",
            AppKind::Cloud => "cloud",
        }
    }
}

impl fmt::Display for AppKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The error returned when a string isn't a known [`AppKind`] kebab value. The DB
/// column mapping ([`AppKindColumn`](crate::db::app_registration::AppKindColumn)) wraps it
/// so a tampered `kind` surfaces as a typed read error rather than a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppKindParseError(pub String);

impl fmt::Display for AppKindParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown app kind: {}", self.0)
    }
}

impl std::error::Error for AppKindParseError {}

impl FromStr for AppKind {
    type Err = AppKindParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "system" => Ok(AppKind::System),
            "self-hosted" => Ok(AppKind::SelfHosted),
            "cloud" => Ok(AppKind::Cloud),
            other => Err(AppKindParseError(other.to_owned())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for k in [AppKind::System, AppKind::SelfHosted, AppKind::Cloud] {
            assert_eq!(k.as_str().parse::<AppKind>(), Ok(k));
        }
    }

    #[test]
    fn unknown_value_is_a_typed_error() {
        assert_eq!(
            "nope".parse::<AppKind>(),
            Err(AppKindParseError("nope".to_owned())),
        );
    }

    /// The kebab string is the one stored in the `CHECK`-constrained column, so
    /// the serde rename and `as_str` must agree.
    #[test]
    fn serde_matches_as_str() {
        for k in [AppKind::System, AppKind::SelfHosted, AppKind::Cloud] {
            let json = serde_json::to_string(&k).unwrap();
            assert_eq!(json, format!("\"{}\"", k.as_str()));
        }
    }
}
