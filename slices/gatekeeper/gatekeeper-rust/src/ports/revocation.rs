//! [`Revocation`] — the token-revocation seam the domain calls out through, so
//! the scope-gated capabilities (`GrantsRevoker`, `TokenRevoker`) and the logout
//! session-revoke stay testable against a stub instead of the concrete
//! [`RevocationStore`](token_revocation_rust::RevocationStore). Object-safe on
//! purpose: the capabilities hold an `Arc<dyn Revocation>` lifted from the state.

use chrono::{DateTime, Utc};

/// Revoke issued tokens. Both operations are implemented over the shared
/// [`RevocationStore`](token_revocation_rust::RevocationStore); a test fake
/// records the calls (or fails, to prove a caller swallows or surfaces the
/// error). Errors are stringified so the port stays free of the store's concrete
/// error type.
pub(crate) trait Revocation: Send + Sync + 'static {
    /// Denylist a single token by its `jti` until `expires_at` (after which
    /// expiry validation rejects it regardless), tagging the row with `reason`.
    ///
    /// # Errors
    ///
    /// Returns the store failure (stringified) when the write fails.
    fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> Result<(), String>;

    /// Bump a subject's revocation epoch to now, killing every access **and**
    /// refresh token issued to it before this instant — the bulk revoke behind a
    /// grant revoke and `/access/revocations` subject revoke.
    ///
    /// # Errors
    ///
    /// Returns the store failure (stringified) when the write fails.
    fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), String>;
}

/// Answer whether an issued token has been revoked — the read side of the
/// same store, kept as its own object-safe seam so the token verifier can be
/// tested against a stub. Errors are stringified for the same reason as
/// [`Revocation`]'s.
///
/// This is one of two enforcement points over the shared store. The token
/// verifier behind gatekeeper's bearer gate runs the full check here (the
/// per-`jti` denylist and the per-subject epoch). `emr-rust`'s
/// `RevocationCheckingProvider` re-checks the `jti` denylist alone inside HFS,
/// because helios's `Principal` carries no `iat`; the gate runs first on every
/// `/fhir-r4/*` request, so the epoch half is still enforced there. Both fail
/// closed on a store error.
pub(crate) trait RevocationCheck: Send + Sync + 'static {
    /// Whether the token identified by `jti` (denylisted individually) or
    /// issued to `subject` at `issued_at` (before the subject's revocation
    /// epoch) is revoked. A missing `jti` skips the per-token check; a missing
    /// `issued_at` skips the epoch check.
    ///
    /// # Errors
    ///
    /// Returns the store failure (stringified) when the read fails; the caller
    /// fails closed.
    fn is_revoked(
        &self,
        jti: Option<&str>,
        issued_at: Option<DateTime<Utc>>,
        subject: &str,
    ) -> Result<bool, String>;
}
