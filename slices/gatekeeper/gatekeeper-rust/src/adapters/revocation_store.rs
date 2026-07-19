//! The token-revocation seam ([`crate::ports`]) adapted onto the shared
//! [`RevocationStore`]. See the [module docs](super) for the composition layer.

use chrono::{DateTime, Utc};

use token_revocation_rust::RevocationStore;

use crate::ports::Revocation;

/// The token-revocation seam — delegates to the shared [`RevocationStore`],
/// stringifying its error so the port stays free of the store's concrete type.
/// The capabilities hold an `Arc<dyn Revocation>` built from a cloned store.
impl Revocation for RevocationStore {
    fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> Result<(), String> {
        RevocationStore::revoke_jti(self, jti, expires_at, reason).map_err(|e| e.to_string())
    }

    fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), String> {
        RevocationStore::revoke_subject_as_of_now(self, subject).map_err(|e| e.to_string())
    }
}
