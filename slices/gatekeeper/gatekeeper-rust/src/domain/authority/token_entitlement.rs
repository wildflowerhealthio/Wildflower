//! [`TokenEntitlement`] — what an access token may claim: the sealed trait the
//! access-token minter mints under. An implementor carries the claims a token may be minted with **privately**,
//! copied from the record or configuration it stands for, so the minter never
//! accepts a bare scope slice a caller assembled.

/// The claims a token may be minted with, supplied by a proof rather than a
/// caller. Sealed: only the proof types in [`crate::domain::authority`]
/// implement it, so the set of things a token can be minted *for* is the set of
/// types in that module.
pub(crate) trait TokenEntitlement: sealed::Sealed {
    /// The `sub` / `client_id` the token is issued to.
    fn client_id(&self) -> &str;
    /// The scopes the token carries, exactly as the proof recorded them.
    fn scopes(&self) -> &[String];
    /// SMART-on-FHIR patient context bound at approval, if any.
    fn patient(&self) -> Option<&str>;
    /// Whether this is the host's own owner token — the one token allowed to
    /// authenticate via the canonical audience at every served origin.
    fn is_host_owner(&self) -> bool;
}

pub(crate) mod sealed {
    /// The sealing trait: implemented alongside each
    /// [`TokenEntitlement`](super::TokenEntitlement) impl inside
    /// `domain::authority`, and nowhere else.
    pub(crate) trait Sealed {}
}
