//! The `/oauth/*` surface's capabilities — the **client-gated** group. Where
//! [`access`](crate::domain::capabilities::access) is unlocked by a caller's
//! scopes, these are unlocked by the OAuth *client* itself: anything a client
//! does on its own behalf takes an
//! [`AuthenticatedClient`](crate::domain::authority::AuthenticatedClient) proof,
//! and the one capability that produces it, [`ClientAuthenticator`], is the
//! door the token-style request extractor goes through.

mod client_authenticator;

pub(crate) use client_authenticator::ClientAuthenticator;
