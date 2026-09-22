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
//!    `/authorize`) and [`AuthorizationStatusReader`] (polling by request id).
//!    Each exposes exactly one operation, so a handler holding one can do
//!    nothing else with the store.

mod authorization_status_reader;
mod client_authenticator;
mod code_authorization_starter;
mod device_authorizer;
mod token_exchanger;

pub(crate) use authorization_status_reader::{
    AuthorizationStatusError, AuthorizationStatusReader, AuthorizationStatusView,
};
pub(crate) use client_authenticator::ClientAuthenticator;
pub(crate) use code_authorization_starter::{
    AuthorizationStart, AuthorizationStartError, AuthorizeRequest, CodeAuthorizationStarter,
    FreshIds,
};
pub(crate) use device_authorizer::{DeviceAuthorizationError, DeviceAuthorizer};
pub(crate) use token_exchanger::{AuthorizationCodeGrant, ExchangedToken, TokenExchanger};
