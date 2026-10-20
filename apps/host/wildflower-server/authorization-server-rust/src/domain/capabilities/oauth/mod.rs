//! The `/oauth/*` surface's capabilities — the pre-auth front door. Where
//! [`access`](crate::domain::capabilities::access) is unlocked by a caller's
//! scopes, these are unlocked by the OAuth *client* or by nobody:
//!
//!  - client-gated: anything a client (an app's back end, authenticating as
//!    its OAuth client) does on its own behalf takes an
//!    [`AuthenticatedClient`](crate::domain::authority::AuthenticatedClient)
//!    proof, produced by [`ClientAuthenticator`] (the door the token-style
//!    request extractor goes through) and consumed by [`TokenExchanger`],
//!    [`ClientTokenRevoker`] and [`DeviceAuthorizer`];
//!  - public: [`CodeAuthorizationStarter`] (a browser arriving at
//!    `/authorize`), [`AuthorizationStatusReader`] (the wait page polling by
//!    request id), and [`PublicKeysReader`] (anyone reading the JWKS). Each
//!    exposes exactly one operation, so a handler holding one can do nothing
//!    else with the store. Public doesn't mean unchecked: the starter only
//!    parks a request, and a code comes from the Owner's decision or a
//!    standing grant, never from the request alone; the status reader answers
//!    only the browser session that made the request, or one holding the
//!    scopes to read any request, so a leaked request id collects nothing;
//!  - in-process: [`LaunchContexts`] mints the SMART App Launch contexts an app
//!    launch hands out (for the host and the apps slice), and
//!    [`CodeAuthorizationStarter`] consumes one inside its scope
//!    ([`consume_launch`]);
//!  - in-process minted: [`SameDeviceSignIn`] redeems a one-time same-device
//!    sign-in code the base minted, signing the Owner's browser in on the
//!    server's own device with a same-device session's token, on its way to an
//!    allowed `next`;
//!  - bound to a browser session: [`SessionShortfall`] reads and cancels a
//!    request waiting on the limited page of the browser that made it, and
//!    [`CodeAuthorizationStarter`] goes on with one;
//!  - bound to a pairing code: [`BrowserPairing`] starts a browser pairing for
//!    a browser that isn't the Owner's, and its page's poll, holding the
//!    request's secret pairing code, starts the paired session once the
//!    Owner approves.

mod authorization_status_reader;
mod browser_pairing;
mod client_authenticator;
mod client_token_revoker;
mod code_authorization_starter;
mod device_authorizer;
mod launch_contexts;
mod public_keys_reader;
mod same_device_sign_in;
mod session_shortfall;
mod token_exchanger;

pub(crate) use authorization_status_reader::{
    AuthorizationStatusError, AuthorizationStatusReader, AuthorizationStatusView,
    PollingBrowserSession,
};
pub(crate) use browser_pairing::{
    BrowserPairing, BrowserPairingPollError, BrowserPairingStartError, BrowserPairingStatus,
    StartedBrowserPairing, PAIRED_SESSION_TTL,
};
pub(crate) use client_authenticator::ClientAuthenticator;
pub(crate) use client_token_revoker::ClientTokenRevoker;
pub(crate) use code_authorization_starter::{
    AuthorizationStartError, AuthorizeNextStep, AuthorizeRequest, CodeAuthorizationStarter,
    FreshIds,
};
pub(crate) use device_authorizer::{DeviceAuthorizationError, DeviceAuthorizer};
pub(crate) use launch_contexts::{consume_launch, LaunchContexts};
pub(crate) use public_keys_reader::PublicKeysReader;
pub(crate) use same_device_sign_in::{
    SameDeviceSignIn, SameDeviceSignInError, SignInRefusal, SignedIn, SAME_DEVICE_SESSION_TTL,
};
pub(crate) use session_shortfall::{SessionShortfall, SessionShortfallView};
pub(crate) use token_exchanger::{IssuedTokens, TokenExchanger};
