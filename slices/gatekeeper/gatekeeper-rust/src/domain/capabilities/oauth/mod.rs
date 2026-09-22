//! The `/oauth/*` surface's capabilities — the **client-gated** group. Where
//! [`access`](crate::domain::capabilities::access) is unlocked by a caller's
//! scopes, these are unlocked by the OAuth *client* itself: anything a client
//! does on its own behalf takes an
//! [`AuthenticatedClient`](crate::domain::authority::AuthenticatedClient) proof,
//! produced by [`ClientAuthenticator`] (the door the token-style request
//! extractor goes through) and consumed by [`TokenExchanger`], the
//! `/oauth/token` flows.

mod client_authenticator;
mod token_exchanger;

pub(crate) use client_authenticator::ClientAuthenticator;
pub(crate) use token_exchanger::{AuthorizationCodeGrant, ExchangedToken, TokenExchanger};
