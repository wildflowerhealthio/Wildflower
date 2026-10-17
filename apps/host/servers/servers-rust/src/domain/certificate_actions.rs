//! The host's actions on a server's certificate, get one now or order a new
//! one in place of the one held: [`running_certificate_actions`], the
//! [`CertificateActions`] of a server's run they go through;
//! [`ensure_below_duplicate_limit`], which refuses an order the CA's
//! duplicate-certificate limit would; and [`CertificateActionError`], why one
//! was refused or failed.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use wildflowerhealthio_unit_runner::{RunState, UnitStatus};
use wildflowerhealthio_wildflower_server::{
    CertificateActions, CertificateRestartError, DuplicateCertificates,
};

use crate::domain::{RegistryError, ServerDetail};

/// Why an action on a server's certificate, or the count of its duplicate
/// certificates, was refused or failed. Serialises as `{"kind", "message"}`.
#[derive(Debug, thiserror::Error)]
pub enum CertificateActionError {
    /// The server isn't running, or its run stopped before it could order:
    /// only a run orders its certificate, since the CA's validation reaches
    /// the server through its tunnel.
    #[error("the server {domain} isn't running")]
    ServerNotRunning { domain: String },
    /// "Order a new certificate" couldn't remove the cached certificate; the
    /// run started its ordering again from it.
    #[error("the server {domain}'s cached certificate couldn't be removed: {message}")]
    CachedCertificateNotRemoved { domain: String, message: String },
    /// The CA has issued as many certificates for the server's domain in its
    /// window as its duplicate-certificate limit allows, so it would refuse
    /// another until the oldest leaves the window.
    #[error(
        "the certificate authority has issued {limit} certificates for {domain} in the last 7 \
         days, its limit; it issues another after {}",
        oldest_leaves_window_at.to_rfc3339_opts(SecondsFormat::Secs, true)
    )]
    DuplicateLimitReached {
        domain: String,
        limit: usize,
        oldest_leaves_window_at: DateTime<Utc>,
    },
    /// The server's certificate history couldn't be read.
    #[error("the server {domain}'s certificate history couldn't be read: {message}")]
    HistoryUnreadable { domain: String, message: String },
    /// Reading the registry failed, including
    /// [`RegistryError::NotRegistered`] for a server that isn't registered.
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

impl CertificateActionError {
    /// The camelCase name the base branches on: one per variant, except that
    /// [`CertificateActionError::Registry`] is its [`RegistryError::kind`].
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ServerNotRunning { .. } => "serverNotRunning",
            Self::CachedCertificateNotRemoved { .. } => "cachedCertificateNotRemoved",
            Self::DuplicateLimitReached { .. } => "duplicateLimitReached",
            Self::HistoryUnreadable { .. } => "historyUnreadable",
            Self::Registry(registry_error) => registry_error.kind(),
        }
    }

    /// The error for the server `domain` whose run couldn't restart its
    /// ordering as asked, with `restart_error`.
    #[must_use]
    pub fn of_restart(domain: &str, restart_error: &CertificateRestartError) -> Self {
        match restart_error {
            CertificateRestartError::RunStopped => Self::ServerNotRunning {
                domain: domain.to_owned(),
            },
            CertificateRestartError::CachedCertificateNotRemoved(io_error) => {
                Self::CachedCertificateNotRemoved {
                    domain: domain.to_owned(),
                    message: io_error.to_string(),
                }
            }
        }
    }
}

impl Serialize for CertificateActionError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("CertificateActionError", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

/// The certificate actions of the run of the server `domain`, whose status
/// on `UnitRunner` is `unit_status`, while it runs: a run puts them in each
/// [`ServerDetail`] it sets.
///
/// # Errors
///
/// [`CertificateActionError::ServerNotRunning`] for a server with no status,
/// one that isn't running, or one whose run hasn't reported yet.
pub fn running_certificate_actions(
    domain: &str,
    unit_status: Option<&UnitStatus<ServerDetail>>,
) -> Result<CertificateActions, CertificateActionError> {
    unit_status
        .filter(|unit_status| unit_status.run_state == RunState::Running)
        .and_then(|unit_status| unit_status.detail.as_ref()?.certificate_actions.clone())
        .ok_or_else(|| CertificateActionError::ServerNotRunning {
            domain: domain.to_owned(),
        })
}

/// Pass an order for the server `domain` unless its CA would refuse it, by
/// the `duplicates` its history records in the CA's window: `None` for a CA
/// with no duplicate-certificate limit to reach.
///
/// # Errors
///
/// [`CertificateActionError::DuplicateLimitReached`] once the window holds as
/// many certificates as the CA's limit.
pub fn ensure_below_duplicate_limit(
    domain: &str,
    duplicates: Option<&DuplicateCertificates>,
) -> Result<(), CertificateActionError> {
    match duplicates {
        Some(
            duplicates @ DuplicateCertificates {
                oldest_leaves_window_at: Some(oldest_leaves_window_at),
                ..
            },
        ) if duplicates.is_at_limit() => Err(CertificateActionError::DuplicateLimitReached {
            domain: domain.to_owned(),
            limit: duplicates.limit,
            oldest_leaves_window_at: *oldest_leaves_window_at,
        }),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::domain::golden;

    const DOMAIN: &str = "ruth.relay.example.com";

    fn oldest_leaves_window_at() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 20, 17, 0, 0).unwrap()
    }

    /// A status of `run_state` whose detail, if any, is `detail`.
    fn unit_status(run_state: RunState, detail: Option<ServerDetail>) -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state,
            running_since: None,
            detail,
        }
    }

    /// A detail with no run behind it, as the domain's tests build theirs.
    fn detail_without_a_server() -> ServerDetail {
        ServerDetail {
            health: None,
            tunnel: None,
            certificate: None,
            pending_consent: None,
            launch_minter: None,
            sign_in_code_minter: None,
            consent_watcher: None,
            certificate_actions: None,
        }
    }

    /// `count` certificates against Let's Encrypt's limit of 5.
    fn duplicates(count: usize) -> DuplicateCertificates {
        DuplicateCertificates {
            limit: 5,
            count,
            oldest_leaves_window_at: (count > 0).then(oldest_leaves_window_at),
        }
    }

    #[test]
    fn a_server_that_is_not_running_has_no_certificate_actions() {
        for status in [
            None,
            Some(unit_status(RunState::Stopped { last_stop: None }, None)),
            Some(unit_status(RunState::Starting, None)),
            Some(unit_status(RunState::Running, None)),
            Some(unit_status(
                RunState::Running,
                Some(detail_without_a_server()),
            )),
        ] {
            let refused = running_certificate_actions(DOMAIN, status.as_ref());
            assert!(
                matches!(
                    refused,
                    Err(CertificateActionError::ServerNotRunning { ref domain }) if domain == DOMAIN
                ),
                "{status:?}"
            );
        }
    }

    #[test]
    fn an_order_below_the_limit_or_from_a_ca_without_one_passes() {
        for duplicates in [None, Some(duplicates(0)), Some(duplicates(4))] {
            assert!(
                ensure_below_duplicate_limit(DOMAIN, duplicates.as_ref()).is_ok(),
                "{duplicates:?}"
            );
        }
    }

    #[test]
    fn an_order_at_the_limit_is_refused_until_the_oldest_leaves_the_window() {
        let refused = ensure_below_duplicate_limit(DOMAIN, Some(&duplicates(5)));
        assert!(
            matches!(
                refused,
                Err(CertificateActionError::DuplicateLimitReached {
                    limit: 5,
                    oldest_leaves_window_at: at,
                    ..
                }) if at == oldest_leaves_window_at()
            ),
            "{refused:?}"
        );
    }

    #[test]
    fn a_stopped_run_is_a_server_that_is_not_running() {
        assert!(matches!(
            CertificateActionError::of_restart(DOMAIN, &CertificateRestartError::RunStopped),
            CertificateActionError::ServerNotRunning { ref domain } if domain == DOMAIN
        ));
    }

    #[test]
    fn the_errors_the_base_shows_are_as_the_golden_file_says() {
        let errors = [
            CertificateActionError::ServerNotRunning {
                domain: DOMAIN.to_owned(),
            },
            CertificateActionError::of_restart(
                DOMAIN,
                &CertificateRestartError::CachedCertificateNotRemoved(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "permission denied",
                )),
            ),
            CertificateActionError::DuplicateLimitReached {
                domain: DOMAIN.to_owned(),
                limit: 5,
                oldest_leaves_window_at: oldest_leaves_window_at(),
            },
            CertificateActionError::HistoryUnreadable {
                domain: DOMAIN.to_owned(),
                message: "permission denied".to_owned(),
            },
            CertificateActionError::Registry(RegistryError::NotRegistered {
                domain: DOMAIN.to_owned(),
            }),
        ];
        assert_eq!(
            serde_json::to_value(errors).unwrap(),
            golden()["certificateActionErrors"]
        );
    }

    #[test]
    fn the_duplicate_counts_the_base_shows_are_as_the_golden_file_says() {
        let golden = golden();
        for (name, duplicates) in [
            ("noneInTheWindow", duplicates(0)),
            ("oneBelowTheLimit", duplicates(4)),
            ("atTheLimit", duplicates(5)),
        ] {
            assert_eq!(
                serde_json::to_value(duplicates).unwrap(),
                golden["duplicateCertificates"][name],
                "{name}"
            );
        }
    }
}
