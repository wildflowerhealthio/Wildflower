//! [`CertificateStateWire`], a server's
//! [`CertificateState`] as `servers_list` and the `server-status` event
//! write it.
//!
//! Written camelCase, with each optional member left out when it is `None`:
//!
//! ```json
//! {
//!   "status": "none" | "ordering" | "valid" | "renewalDue" | "expired" | "failed",
//!   "issuer": "letsEncryptStaging" | "letsEncrypt",
//!   "issued": {
//!     "notBefore": "<RFC 3339>",
//!     "notAfter": "<RFC 3339>",
//!     "fingerprint": "<SHA-256 of the leaf's DER, lowercase hex>"
//!   },
//!   "lastError": {"kind": "rateLimited", "retryAfter": "<RFC 3339>"}
//!              | {"kind": "challengeFailed", "detail": "…"}
//!              | {"kind": "caUnreachable", "message": "…"}
//!              | {"kind": "other", "message": "…"}
//! }
//! ```
//!
//! `retryAfter` and `detail` only when the CA gave them.

use chrono::{DateTime, Utc};
use serde::Serialize;
use wildflower_server_rust::{
    CertificateAuthority, CertificateOrderError, CertificateState, CertificateStatus,
    IssuedCertificate,
};

/// [`CertificateState`]'s wire shape, borrowed from the state it writes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertificateStateWire<'a> {
    status: CertificateStatusWire,
    issuer: CertificateAuthority,
    #[serde(skip_serializing_if = "Option::is_none")]
    issued: Option<IssuedCertificateWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<CertificateOrderErrorWire<'a>>,
}

impl<'a> CertificateStateWire<'a> {
    pub(crate) fn of(state: &'a CertificateState) -> Self {
        Self {
            status: CertificateStatusWire::of(state.status),
            issuer: state.issuer,
            issued: state.issued.as_ref().map(IssuedCertificateWire::of),
            last_error: state.last_error.as_ref().map(CertificateOrderErrorWire::of),
        }
    }
}

/// [`CertificateStatus`]'s wire names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum CertificateStatusWire {
    None,
    Ordering,
    Valid,
    RenewalDue,
    Expired,
    Failed,
}

impl CertificateStatusWire {
    fn of(status: CertificateStatus) -> Self {
        match status {
            CertificateStatus::None => Self::None,
            CertificateStatus::Ordering => Self::Ordering,
            CertificateStatus::Valid => Self::Valid,
            CertificateStatus::RenewalDue => Self::RenewalDue,
            CertificateStatus::Expired => Self::Expired,
            CertificateStatus::Failed => Self::Failed,
        }
    }
}

/// [`IssuedCertificate`]'s wire shape.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IssuedCertificateWire<'a> {
    not_before: DateTime<Utc>,
    not_after: DateTime<Utc>,
    fingerprint: &'a str,
}

impl<'a> IssuedCertificateWire<'a> {
    fn of(issued: &'a IssuedCertificate) -> Self {
        Self {
            not_before: issued.not_before,
            not_after: issued.not_after,
            fingerprint: &issued.fingerprint,
        }
    }
}

/// [`CertificateOrderError`]'s wire shape.
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum CertificateOrderErrorWire<'a> {
    RateLimited {
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after: Option<DateTime<Utc>>,
    },
    ChallengeFailed {
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<&'a str>,
    },
    CaUnreachable {
        message: &'a str,
    },
    Other {
        message: &'a str,
    },
}

impl<'a> CertificateOrderErrorWire<'a> {
    fn of(error: &'a CertificateOrderError) -> Self {
        match error {
            CertificateOrderError::RateLimited { retry_after } => Self::RateLimited {
                retry_after: *retry_after,
            },
            CertificateOrderError::ChallengeFailed { detail } => Self::ChallengeFailed {
                detail: detail.as_deref(),
            },
            CertificateOrderError::CaUnreachable { message } => Self::CaUnreachable { message },
            CertificateOrderError::Other { message } => Self::Other { message },
        }
    }
}
