//! The `/oauth/*` surface's capabilities — the pre-auth front door. Where
//! [`access`](crate::domain::capabilities::access) is unlocked by a caller's
//! scopes, these are unlocked by the OAuth *client* or by nobody:
//!
//!  - client-gated: anything a client does on its own behalf takes an
//!    [`AuthenticatedClient`](crate::domain::authority::AuthenticatedClient)
//!    proof, produced by [`ClientAuthenticator`] (the door the token-style
//!    request extractor goes through) and consumed by [`TokenExchanger`] and
//!    [`DeviceAuthorizer`];
//!  - public: [`CodeAuthorizationStarter`] (a browser arriving at
//!    `/authorize`), [`AuthorizationStatusReader`] (polling by request id),
//!    [`PublicKeysReader`] (the JWKS), and [`ClientScopesReader`] (the host's
//!    per-app launch check). Each exposes exactly one operation, so a handler
//!    holding one can do nothing else with the store;
//!  - in-process: [`LaunchContexts`] mints the SMART App Launch contexts an app
//!    launch hands out (for the host and the apps slice) and consumes them for
//!    [`CodeAuthorizationStarter`];
//!  - in-process minted: [`SameDeviceSignIn`] redeems a one-time same-device sign-in code the
//!    base minted for an Owner session's token, on its way to an allowed `next`.

mod authorization_status_reader;
mod client_authenticator;
mod client_scopes_reader;
mod code_authorization_starter;
mod device_authorizer;
mod launch_contexts;
mod public_keys_reader;
mod same_device_sign_in;
mod token_exchanger;

pub(crate) use authorization_status_reader::{
    AuthorizationStatusError, AuthorizationStatusReader, AuthorizationStatusView,
};
pub(crate) use client_authenticator::ClientAuthenticator;
pub(crate) use client_scopes_reader::ClientScopesReader;
pub(crate) use code_authorization_starter::{
    AuthorizationStartError, AuthorizeNextStep, AuthorizeRequest, CodeAuthorizationStarter,
    FreshIds,
};
pub(crate) use device_authorizer::{DeviceAuthorizationError, DeviceAuthorizer};
pub(crate) use launch_contexts::LaunchContexts;
pub(crate) use public_keys_reader::PublicKeysReader;
pub(crate) use same_device_sign_in::{
    SameDeviceSignIn, SameDeviceSignInError, SignInRefusal, SignedIn, OWNER_SESSION_TTL,
};
pub(crate) use token_exchanger::{IssuedTokens, TokenExchanger};
