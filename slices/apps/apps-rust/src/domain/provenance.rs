//! `Provenance` — how an app's launch target is resolved. Fixed per parent
//! registry row (the `apps.provenance` column) and what the launch handler
//! dispatches on:
//!
//!   * [`Provenance::System`] — a compiled-in [`SystemApp`](super::SystemApp)
//!     source supplies the launch URL (no child table row).
//!   * [`Provenance::SelfHosted`] — a `self_hosted_apps` child row carries the
//!     dedicated loopback `port`; the launch handler renders
//!     `http://{host}:{port}/` (loopback) or `https://{id}.{public_host}/`
//!     (forwarded).
//!   * [`Provenance::Cloud`] — a `cloud_apps` child row carries the remote
//!     `https://` launch template substituted at launch.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// How an app's launch target resolves. Serialized — wire + SQLite — as its
/// kebab string (`"system"` / `"self-hosted"` / `"cloud"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Provenance {
    /// Compiled-in source ([`SystemApp`](super::SystemApp)); no child table row.
    System,
    /// Locally-served app on a dedicated loopback `port` (`self_hosted_apps`).
    SelfHosted,
    /// Remote `https://` launch template (`cloud_apps`).
    Cloud,
}

impl Provenance {
    /// The canonical kebab string stored in the `apps.provenance` column and
    /// matched by the table's `CHECK` constraint. The single source of truth
    /// for the DB [`ToSql`](rusqlite::ToSql) / [`FromSql`](rusqlite::types::FromSql)
    /// mapping and [`fmt::Display`].
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Provenance::System => "system",
            Provenance::SelfHosted => "self-hosted",
            Provenance::Cloud => "cloud",
        }
    }
}

impl fmt::Display for Provenance {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The error returned when a string isn't a known [`Provenance`] kebab value.
/// The DB layer wraps it in `FromSqlError::Other` so a tampered row surfaces as
/// a typed read error rather than a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvenanceParseError(pub String);

impl fmt::Display for ProvenanceParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown provenance: {}", self.0)
    }
}

impl std::error::Error for ProvenanceParseError {}

impl FromStr for Provenance {
    type Err = ProvenanceParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "system" => Ok(Provenance::System),
            "self-hosted" => Ok(Provenance::SelfHosted),
            "cloud" => Ok(Provenance::Cloud),
            other => Err(ProvenanceParseError(other.to_owned())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_round_trips_through_from_str() {
        for p in [
            Provenance::System,
            Provenance::SelfHosted,
            Provenance::Cloud,
        ] {
            assert_eq!(p.as_str().parse::<Provenance>(), Ok(p));
        }
    }

    #[test]
    fn unknown_value_is_a_typed_error() {
        assert_eq!(
            "nope".parse::<Provenance>(),
            Err(ProvenanceParseError("nope".to_owned())),
        );
    }

    /// The kebab string is the one stored in the `CHECK`-constrained column, so
    /// the serde rename and `as_str` must agree.
    #[test]
    fn serde_matches_as_str() {
        for p in [
            Provenance::System,
            Provenance::SelfHosted,
            Provenance::Cloud,
        ] {
            let json = serde_json::to_string(&p).unwrap();
            assert_eq!(json, format!("\"{}\"", p.as_str()));
        }
    }
}
