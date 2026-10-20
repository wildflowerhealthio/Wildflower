//! The access tokens the authorization server signs: what they claim
//! (`claims`), how one is minted (`mint`) and how an incoming one is
//! verified (`verify`). Each is an RS256 JWT signed with a key from the
//! signing-key store. One issued at `/oauth/token` lives for
//! [`ACCESS_TOKEN_TTL`]; a browser session's token lives as long as its
//! session.

mod claims;
mod mint;
mod verify;

use chrono::Duration;

pub use claims::{AccessTokenClaims, VerifiedClaims};
pub(crate) use mint::AccessTokenIssuanceError;
pub use mint::{mint_access_token, AccessTokenMintError, NewAccessTokenArgs};
pub use verify::{verify_access_token, AccessTokenVerifyError, AccessTokenVerifyOptions};

/// The lifetime of an access token issued at `/oauth/token`. A paired
/// browser's token and the Owner's sign-in token are minted with lifetimes of
/// their own. The consent UI's
/// `offline_access` copy ("Access your data after 15 minutes") states this
/// value — keep the two in step.
pub const ACCESS_TOKEN_TTL: Duration = Duration::minutes(15);
