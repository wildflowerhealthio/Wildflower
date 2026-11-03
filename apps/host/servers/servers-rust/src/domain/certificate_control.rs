//! The host's orders for a server's certificate, if needed or forced (see
//! [`CertificateOrderKind`](wildflowerhealthio_wildflower_server::CertificateOrderKind)):
//! [`running_certificate_control`], the [`RunningCertificateControl`] of a
//! server's run they go through; [`ensure_limit_not_used_up`], which refuses
//! a forced order once the CA's duplicate-certificate limit looks used up;
//! and [`CertificateOrderRequestError`], why one was refused or failed.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use wildflowerhealthio_unit_runner::{RunState, UnitStatus};
use wildflowerhealthio_wildflower_server::{
    CertificateControlError, DuplicateCertificateLimit, RunningCertificateControl,
};

use crate::domain::{RegistryError, ServerDetail};

/// Why an order for a server's certificate, or reading its
/// duplicate-certificate limit, was refused or failed. Serialises as
/// `{"kind", "message"}`.
#[derive(Debug, thiserror::Error)]
pub enum CertificateOrderRequestError {
    /// The server isn't running, or its run stopped before it could order:
    /// only a run orders its certificate, since the CA's validation reaches
    /// the server through its tunnel.
    #[error("the server {domain} isn't running")]
    ServerNotRunning { domain: String },
    /// A forced order couldn't remove the cached certificate; the run
    /// started its ordering again from it.
    #[error("the server {domain}'s cached certificate couldn't be removed: {message}")]
    CachedCertificateNotRemoved { domain: String, message: String },
    /// By the server's certificate history, the CA has issued as many
    /// certificates for the server's domain in its window as its
    /// duplicate-certificate limit allows, so it would refuse another until
    /// the oldest leaves the window.
    #[error(
        "the certificate authority has issued all {allowed} certificates it allows {domain} in 7 \
         days; it issues another after {}",
        oldest_leaves_window_at.to_rfc3339_opts(SecondsFormat::Secs, true)
    )]
    LimitUsedUp {
        domain: String,
        allowed: usize,
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

impl CertificateOrderRequestError {
    /// The camelCase name the base branches on: one per variant, except that
    /// [`CertificateOrderRequestError::Registry`] is its [`RegistryError::kind`].
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ServerNotRunning { .. } => "serverNotRunning",
            Self::CachedCertificateNotRemoved { .. } => "cachedCertificateNotRemoved",
            Self::LimitUsedUp { .. } => "limitUsedUp",
            Self::HistoryUnreadable { .. } => "historyUnreadable",
            Self::Registry(registry_error) => registry_error.kind(),
        }
    }

    /// The error for the server `domain` whose run couldn't restart its
    /// ordering as asked, with `control_error`.
    #[must_use]
    pub fn of_control(domain: &str, control_error: &CertificateControlError) -> Self {
        match control_error {
            CertificateControlError::RunStopped => Self::ServerNotRunning {
                domain: domain.to_owned(),
            },
            CertificateControlError::CachedCertificateNotRemoved(io_error) => {
                Self::CachedCertificateNotRemoved {
                    domain: domain.to_owned(),
                    message: io_error.to_string(),
                }
            }
        }
    }
}

impl Serialize for CertificateOrderRequestError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("CertificateOrderRequestError", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

/// The certificate control of the run of the server `domain`, whose status
/// on `UnitRunner` is `unit_status`, while it runs: a run puts it in each
/// [`ServerDetail`] it sets.
///
/// # Errors
///
/// [`CertificateOrderRequestError::ServerNotRunning`] for a server with no status,
/// one that isn't running, or one whose run hasn't reported yet.
pub fn running_certificate_control(
    domain: &str,
    unit_status: Option<&UnitStatus<ServerDetail>>,
) -> Result<RunningCertificateControl, CertificateOrderRequestError> {
    unit_status
        .filter(|unit_status| unit_status.run_state == RunState::Running)
        .and_then(|unit_status| unit_status.detail.as_ref()?.certificate_control.clone())
        .ok_or_else(|| CertificateOrderRequestError::ServerNotRunning {
            domain: domain.to_owned(),
        })
}

/// Pass an order for the server `domain` unless its CA would refuse it, by
/// the `limit` its history estimates it has used: `None` for a CA with no
/// duplicate-certificate limit.
///
/// # Errors
///
/// [`CertificateOrderRequestError::LimitUsedUp`] once the window holds as many
/// certificates as the CA allows.
pub fn ensure_limit_not_used_up(
    domain: &str,
    limit: Option<&DuplicateCertificateLimit>,
) -> Result<(), CertificateOrderRequestError> {
    match limit {
        Some(
            limit @ DuplicateCertificateLimit {
                oldest_leaves_window_at: Some(oldest_leaves_window_at),
                ..
            },
        ) if limit.is_used_up() => Err(CertificateOrderRequestError::LimitUsedUp {
            domain: domain.to_owned(),
            allowed: limit.allowed,
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
            certificate_control: None,
        }
    }

    /// Let's Encrypt's limit of 5, with `used` of them used.
    fn limit_used(used: usize) -> DuplicateCertificateLimit {
        DuplicateCertificateLimit {
            allowed: 5,
            used,
            oldest_leaves_window_at: (used > 0).then(oldest_leaves_window_at),
        }
    }

    #[test]
    fn a_server_that_is_not_running_has_no_certificate_control() {
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
            let refused = running_certificate_control(DOMAIN, status.as_ref());
            assert!(
                matches!(
                    refused,
                    Err(CertificateOrderRequestError::ServerNotRunning { ref domain }) if domain == DOMAIN
                ),
                "{status:?}"
            );
        }
    }

    #[test]
    fn an_order_within_the_limit_or_from_a_ca_without_one_passes() {
        for limit in [None, Some(limit_used(0)), Some(limit_used(4))] {
            assert!(
                ensure_limit_not_used_up(DOMAIN, limit.as_ref()).is_ok(),
                "{limit:?}"
            );
        }
    }

    #[test]
    fn an_order_once_the_limit_is_used_up_is_refused_until_the_oldest_leaves_the_window() {
        let refused = ensure_limit_not_used_up(DOMAIN, Some(&limit_used(5)));
        assert!(
            matches!(
                refused,
                Err(CertificateOrderRequestError::LimitUsedUp {
                    allowed: 5,
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
            CertificateOrderRequestError::of_control(DOMAIN, &CertificateControlError::RunStopped),
            CertificateOrderRequestError::ServerNotRunning { ref domain } if domain == DOMAIN
        ));
    }

    #[test]
    fn the_errors_the_base_shows_are_as_the_golden_file_says() {
        let errors = [
            CertificateOrderRequestError::ServerNotRunning {
                domain: DOMAIN.to_owned(),
            },
            CertificateOrderRequestError::of_control(
                DOMAIN,
                &CertificateControlError::CachedCertificateNotRemoved(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "permission denied",
                )),
            ),
            CertificateOrderRequestError::LimitUsedUp {
                domain: DOMAIN.to_owned(),
                allowed: 5,
                oldest_leaves_window_at: oldest_leaves_window_at(),
            },
            CertificateOrderRequestError::HistoryUnreadable {
                domain: DOMAIN.to_owned(),
                message: "permission denied".to_owned(),
            },
            CertificateOrderRequestError::Registry(RegistryError::NotRegistered {
                domain: DOMAIN.to_owned(),
            }),
        ];
        assert_eq!(
            serde_json::to_value(errors).unwrap(),
            golden()["certificateOrderRequestErrors"]
        );
    }

    #[test]
    fn the_limits_the_base_shows_are_as_the_golden_file_says() {
        let golden = golden();
        for (name, limit) in [
            ("noneInTheWindow", limit_used(0)),
            ("oneBelowTheLimit", limit_used(4)),
            ("atTheLimit", limit_used(5)),
        ] {
            assert_eq!(
                serde_json::to_value(limit).unwrap(),
                golden["duplicateCertificateLimit"][name],
                "{name}"
            );
        }
    }
}
