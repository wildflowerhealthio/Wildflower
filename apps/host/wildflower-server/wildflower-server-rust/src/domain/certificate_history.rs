//! [`CertificateHistoryEntry`]: one certificate a server deployed, as its
//! certificate history records it; and [`DuplicateCertificates`], how many
//! of them count toward its CA's duplicate-certificate limit.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::domain::certificate_authority::DUPLICATE_CERTIFICATE_WINDOW;
use crate::{CertificateAuthority, IssuedCertificate};

/// One certificate a server's run deployed, recorded once, the first time it
/// was deployed. Written camelCase:
/// `{deployedAt, issuer, fingerprint, notBefore, notAfter}`, the dates in
/// RFC 3339.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateHistoryEntry {
    /// When the run first deployed the certificate.
    pub deployed_at: DateTime<Utc>,
    /// The CA that issued it.
    pub issuer: CertificateAuthority,
    /// Its fingerprint (see [`IssuedCertificate::fingerprint`]).
    pub fingerprint: String,
    /// When it became valid.
    pub not_before: DateTime<Utc>,
    /// When it expires.
    pub not_after: DateTime<Utc>,
}

impl CertificateHistoryEntry {
    /// The entry for `issued`, from `issuer`, deployed at `deployed_at`.
    #[must_use]
    pub fn deployed(
        issued: &IssuedCertificate,
        issuer: CertificateAuthority,
        deployed_at: DateTime<Utc>,
    ) -> Self {
        Self {
            deployed_at,
            issuer,
            fingerprint: issued.fingerprint.clone(),
            not_before: issued.not_before,
            not_after: issued.not_after,
        }
    }

    /// Whether `self` is a certificate `history` hasn't recorded: a run
    /// deploys its cached certificate again at every start, and that one is
    /// recorded already, as the latest entry or, when a newer one's store
    /// failed, an earlier one.
    #[must_use]
    pub(crate) fn is_new_to(&self, history: &[Self]) -> bool {
        history
            .iter()
            .all(|recorded| recorded.fingerprint != self.fingerprint)
    }
}

/// How many certificates a server's history records from a CA within its
/// duplicate-certificate window, against the CA's limit. Every certificate a
/// server holds is for its one domain, so each counts toward the limit on
/// that exact name. Written camelCase:
/// `{limit, count, oldestLeavesWindowAt?}`.
///
/// # Remarks
///
/// A certificate counts from when the run first deployed it, never earlier
/// than the CA issued it, so the count never misses one the CA still counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCertificates {
    /// How many certificates for the same name the CA issues in its window.
    pub limit: usize,
    /// How many certificates the history records from the CA in the window.
    pub count: usize,
    /// When the oldest of those leaves the window; `None` when there are none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_leaves_window_at: Option<DateTime<Utc>>,
}

impl DuplicateCertificates {
    /// The certificates `history` records from `issuer` within the window
    /// ending at `now`; `None` when `issuer` has no duplicate-certificate
    /// limit.
    #[must_use]
    pub fn in_history(
        history: &[CertificateHistoryEntry],
        issuer: CertificateAuthority,
        now: DateTime<Utc>,
    ) -> Option<Self> {
        let limit = issuer.duplicate_certificate_limit()?;
        let window_start = now - DUPLICATE_CERTIFICATE_WINDOW;
        let in_window = || {
            history
                .iter()
                .filter(move |entry| entry.issuer == issuer && entry.deployed_at > window_start)
        };
        Some(Self {
            limit,
            count: in_window().count(),
            oldest_leaves_window_at: in_window()
                .map(|entry| entry.deployed_at + DUPLICATE_CERTIFICATE_WINDOW)
                .min(),
        })
    }

    /// Whether the CA would refuse another certificate for the name now:
    /// the window holds as many as its limit.
    #[must_use]
    pub fn is_at_limit(&self) -> bool {
        self.count >= self.limit
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, TimeZone};

    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 16, 12, 0, 0).unwrap()
    }

    /// A certificate from `issuer` the run first deployed `age` before
    /// [`now`].
    fn deployed_ago(age: TimeDelta, issuer: CertificateAuthority) -> CertificateHistoryEntry {
        let deployed_at = now() - age;
        CertificateHistoryEntry {
            deployed_at,
            issuer,
            fingerprint: format!("{deployed_at}"),
            not_before: deployed_at,
            not_after: deployed_at + TimeDelta::days(90),
        }
    }

    #[test]
    fn only_the_ca_s_certificates_inside_its_window_count() {
        // Arrange
        let history = [
            deployed_ago(TimeDelta::days(8), CertificateAuthority::LetsEncrypt),
            deployed_ago(TimeDelta::days(7), CertificateAuthority::LetsEncrypt),
            deployed_ago(TimeDelta::days(6), CertificateAuthority::LetsEncrypt),
            deployed_ago(TimeDelta::days(1), CertificateAuthority::LetsEncryptStaging),
            deployed_ago(TimeDelta::hours(1), CertificateAuthority::LetsEncrypt),
        ];

        // Act
        let duplicates =
            DuplicateCertificates::in_history(&history, CertificateAuthority::LetsEncrypt, now());

        // Assert: 8 and exactly 7 days ago are out, as is staging's.
        assert_eq!(
            duplicates,
            Some(DuplicateCertificates {
                limit: 5,
                count: 2,
                oldest_leaves_window_at: Some(now() + TimeDelta::days(1)),
            })
        );
    }

    #[test]
    fn no_certificates_in_the_window_count_none_and_leave_none() {
        let history = [deployed_ago(
            TimeDelta::days(30),
            CertificateAuthority::LetsEncrypt,
        )];
        assert_eq!(
            DuplicateCertificates::in_history(&history, CertificateAuthority::LetsEncrypt, now()),
            Some(DuplicateCertificates {
                limit: 5,
                count: 0,
                oldest_leaves_window_at: None,
            })
        );
    }

    #[test]
    fn a_ca_without_a_duplicate_limit_has_no_count() {
        let history = [deployed_ago(
            TimeDelta::hours(1),
            CertificateAuthority::LetsEncryptStaging,
        )];
        assert_eq!(
            DuplicateCertificates::in_history(
                &history,
                CertificateAuthority::LetsEncryptStaging,
                now()
            ),
            None
        );
    }

    #[test]
    fn the_limit_is_reached_at_its_count() {
        let duplicates_of = |count| DuplicateCertificates {
            limit: 5,
            count,
            oldest_leaves_window_at: Some(now()),
        };
        assert!(!duplicates_of(4).is_at_limit());
        assert!(duplicates_of(5).is_at_limit());
    }

    #[test]
    fn the_count_is_written_camel_case() {
        let duplicates = DuplicateCertificates {
            limit: 5,
            count: 4,
            oldest_leaves_window_at: Some(now()),
        };
        assert_eq!(
            serde_json::to_value(&duplicates).unwrap(),
            serde_json::json!({
                "limit": 5,
                "count": 4,
                "oldestLeavesWindowAt": "2026-10-16T12:00:00Z",
            })
        );
    }
}
