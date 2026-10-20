//! **Authority proofs** — the typed answer to "on what authority is this row
//! written?". Every privileged write (approve a request, issue a code, record or
//! widen a grant, widen a registration, start a browser session, mint a
//! token) happens in exactly one
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
//!  - [`DelegatedScopes`] — what an approver (the Owner, or a browser the
//!    Owner paired) may delegate: it held the prompt's approval scopes; each
//!    ticked scope survives only if covered by a requested scope **and** by
//!    the registration ceiling (a code prompt's: the registered scopes, plus
//!    what it requested for a client trusted on first use; a device prompt's
//!    registered scopes fill both halves, a pairing's the Owner's scopes);
//!    and every surviving held access (a resource scope or
//!    `wildflower/launch`) is covered by the approver's own grant. Identity
//!    and session markers (`openid`, `offline_access`, …) pass that last
//!    check. So no grant, code, or widened registration carries held access
//!    the approver did not hold, and only a proof whose approver could write
//!    the client registration writes it.
//!  - [`RedeemedAuthorizationCode`], [`ConsumedDeviceRequest`],
//!    [`ValidatedRefreshToken`] — the redemptions an access token is minted
//!    under at `/oauth/token`; each carries the scopes of the record it
//!    redeemed, so a token holds only what the consent behind it recorded.
//!  - [`StandingGrantCoverage`] — a standing grant already covers every scope
//!    of a *registered* request: the `/oauth/authorize` fast path's authority
//!    to issue a code with no human in the loop.
//!  - [`RedeemedSameDeviceSignInCode`] — a one-time same-device sign-in code the base minted
//!    in-process, redeemed at `/oauth/sign-in`: the authority a same-device
//!    session is started and its token minted under, as the Owner's
//!    client and grant.
//!  - [`ClaimedBrowserPairing`] — a browser pairing the Owner approved,
//!    claimed once by the poll of the page that started it: the authority a
//!    paired browser session is started and its token minted under, with the
//!    scopes the Owner granted.
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
//! Each constructor that reads the store takes the calling capability's scope
//! (`&mut impl GrantTx`), so the proof is checked against the rows the
//! operation then writes, under the same lock.
//!
//! Not proofs: the registration-acknowledgement check (a consent-UI rule run
//! before anything is written) and the request transitions that grant no
//! authority (park, poll stamps, deny, raise for the Owner, the limited
//! page's Continue and Cancel), which any flow writes through the guarded
//! replace.

mod authenticated_client;
mod browser_pairing;
mod delegated_scopes;
mod redemption;
mod same_device_sign_in;
mod standing_grant;
mod token_entitlement;

pub(crate) use authenticated_client::{AuthenticatedClient, ClientAuthenticationError};
pub(crate) use browser_pairing::ClaimedBrowserPairing;
pub(crate) use delegated_scopes::{
    session_bounded_scopes, session_shortfall, ApprovableScopes, DelegatedScopes,
};
pub(crate) use redemption::{
    ConsumedDeviceRequest, GrantRedemption, PresentedAuthorizationCode, RedeemedAuthorizationCode,
    ValidatedRefreshToken,
};
pub(crate) use same_device_sign_in::RedeemedSameDeviceSignInCode;
pub(crate) use standing_grant::{GrantCoverage, StandingGrantCoverage};
pub(crate) use token_entitlement::TokenEntitlement;
