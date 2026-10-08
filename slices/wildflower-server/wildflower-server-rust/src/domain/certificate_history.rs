//! [`CertificateHistoryEntry`]: one certificate a server deployed, as its
//! certificate history records it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

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
