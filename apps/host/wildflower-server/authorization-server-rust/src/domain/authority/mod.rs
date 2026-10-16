//! **Authority proofs** — the typed answer to "on what authority is this row
//! written?". Every privileged write (approve a request, issue a code, record or
//! widen a grant, widen a registration, mint a token) happens in exactly one
//! [`writer`](crate::domain::capabilities::writers), and each writer method
//! takes one of these proofs as its argument. A proof has private fields and a
//! single constructor — the function that checks the rule it stands for — so
//! holding the value *is* the evidence the check ran.
//!
//! The audit is therefore two short lists: the constructors here, and the
//! writers (a source guard pins every privileged store call to them).
//!
//!  - [`AuthenticatedClient`] — an OAuth client that exists, is enabled, and
//!    (if confidential) presented its secret. Everything a client does on its
//!    own behalf takes one.
//!  - [`DelegatedScopes`] — what an approving Owner may delegate: clamped to
//!    the approvable scopes (requested ∩ allowed) **and** covered by the
//!    approver's own grant. No grant, code, or widened registration can carry a
//!    scope the approver did not hold.
//!  - [`RedeemedAuthorizationCode`], [`ConsumedDeviceRequest`],
//!    [`ValidatedRefreshToken`] — the redemptions an access token is minted
//!    under at `/oauth/token`; each carries the scopes of the record it
//!    redeemed, so a token holds only what the consent behind it recorded.
//!  - [`StandingGrantCoverage`] — a standing grant already covers every scope
//!    of a *registered* request: the `/oauth/authorize` fast path's authority
//!    to issue a code with no human in the loop.
//!  - [`RedeemedSameDeviceSignInCode`] — a one-time same-device sign-in code the base minted
//!    in-process, redeemed at `/oauth/sign-in`: the authority an Owner
//!    session is started and its token minted under, as the Owner's
//!    client and grant.
//!  - [`TokenEntitlement`] — the enum the minter mints under, one variant per
//!    proof above that a token may be minted for; each carries its claims
//!    privately, so a token's scopes are never a caller-assembled slice.
//!    [`GrantRedemption`] is the same shape for the two redemptions that may
//!    start a refresh-token family.
//!
//! The sets of proofs a writer accepts are enums rather than traits on purpose
//! ([`TokenEntitlement`], [`GrantRedemption`], and the writers'
//! `CodeAuthority`): a closed list in one place is what an audit reads, and a
//! new source of authority has to be added there.
//!
//! Not proofs: the registration-acknowledgement check (a consent-UI rule run
//! before any clamp) and the pending-request bookkeeping writes (park, poll,
//! deny), which grant no authority and stay on the ordinary store port.

mod authenticated_client;
mod delegated_scopes;
mod redemption;
mod same_device_sign_in;
mod standing_grant;
mod token_entitlement;

pub(crate) use authenticated_client::{AuthenticatedClient, ClientAuthenticationError};
pub(crate) use delegated_scopes::{ApprovableScopes, DelegatedScopes};
pub(crate) use redemption::{
    ConsumedDeviceRequest, GrantRedemption, PresentedAuthorizationCode, RedeemedAuthorizationCode,
    ValidatedRefreshToken,
};
pub(crate) use same_device_sign_in::RedeemedSameDeviceSignInCode;
pub(crate) use standing_grant::{GrantCoverage, StandingGrantCoverage};
pub(crate) use token_entitlement::TokenEntitlement;
