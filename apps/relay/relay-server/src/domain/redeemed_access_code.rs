//! [`RedeemedAccessCode`] — a tunnel just created for an access code.

use crate::domain::{StoredAccessCode, StoredTunnel};

/// A tunnel created by redeeming an access code: the tunnel as it is now
/// stored, whose token is shown only to the caller of `POST /access`, and
/// the code it burned, for putting it back should serving the tunnel fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemedAccessCode {
    pub stored: StoredTunnel,
    pub access_code: StoredAccessCode,
}
