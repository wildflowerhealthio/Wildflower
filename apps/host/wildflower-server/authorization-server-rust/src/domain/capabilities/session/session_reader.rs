//! [`SessionReader`] — the caller reading back their *own* session: what the
//! token they presented carries. Every field is derived from that token, so
//! the read can't disclose anything the caller doesn't already hold.

use crate::domain::token::VerifiedClaims;

/// Read the caller's own session. Built from the caller's claims alone.
pub(crate) struct SessionReader {
    claims: VerifiedClaims,
}

impl SessionReader {
    /// Build the reader over the caller's own claims.
    pub(crate) fn new(claims: VerifiedClaims) -> Self {
        SessionReader { claims }
    }

    /// The `scope` claim split on whitespace — the scopes this session actually
    /// holds. Empty when the token carries no `scope` claim at all.
    pub(crate) fn scopes(&self) -> Vec<String> {
        self.claims
            .scope
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_owned)
            .collect()
    }
}
