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
//!  - host-answered: [`LoopbackOwnerApprover`] puts a direct-loopback login by
//!    the hosted owner UI to the host's native dialog and applies the Owner's
//!    answer, with the host Owner's grant as the approving authority.

mod authorization_status_reader;
mod client_authenticator;
mod client_scopes_reader;
mod code_authorization_starter;
mod device_authorizer;
mod loopback_owner_approver;
mod public_keys_reader;
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
pub(crate) use loopback_owner_approver::{
    asks_loopback_dialog, LoopbackOwnerApprover, HOSTED_OWNER_UI_CLIENT_ID,
};
pub(crate) use public_keys_reader::PublicKeysReader;
pub(crate) use token_exchanger::{IssuedTokens, TokenExchanger};
