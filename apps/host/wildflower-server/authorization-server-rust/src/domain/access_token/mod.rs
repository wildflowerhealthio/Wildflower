//! The access tokens the authorization server signs: what they claim
//! (`claims`), how one is minted (`mint`) and how an incoming one is
//! verified (`verify`). Each is an RS256 JWT signed with a key from the
//! signing-key store and lives for [`ACCESS_TOKEN_TTL`].

mod claims;
mod mint;
mod verify;

use chrono::Duration;

pub use claims::{AccessTokenClaims, VerifiedClaims};
pub(crate) use mint::AccessTokenIssuanceError;
pub use mint::{mint_access_token, AccessTokenMintError, NewAccessTokenArgs};
pub use verify::{verify_access_token, AccessTokenVerifyError, AccessTokenVerifyOptions};

/// Lifetime of access tokens minted by the authorization server. The consent UI's
/// `offline_access` copy ("Access your data after 15 minutes") states this
/// value — keep the two in step.
pub const ACCESS_TOKEN_TTL: Duration = Duration::minutes(15);
