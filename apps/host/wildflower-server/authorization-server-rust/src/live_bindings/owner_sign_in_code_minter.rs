//! The [`OwnerSignInCodeMinter`] binding — the mint half of the Owner
//! sign-in codes, for the host, in-process. Redeeming a code stays inside the
//! authorization server, at `/oauth/sign-in`.

use std::sync::Arc;

use chrono::Utc;

use crate::crypto_util::random_token::generate_owner_sign_in_code;
use crate::domain::owner_sign_in_codes::OwnerSignInCodes;

/// Mint one-time Owner sign-in codes. Cheap to clone (the codes are shared).
/// [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::owner_sign_in_code_minter`](crate::AuthorizationServer::owner_sign_in_code_minter).
#[derive(Clone)]
pub struct OwnerSignInCodeMinter {
    codes: Arc<OwnerSignInCodes>,
}

impl OwnerSignInCodeMinter {
    /// A minter over the authorization server's outstanding codes.
    pub(crate) fn new(codes: Arc<OwnerSignInCodes>) -> Self {
        OwnerSignInCodeMinter { codes }
    }

    /// Mint a sign-in code and return it, for the `code` of
    /// `/oauth/sign-in?code=…&next=…`. Whoever presents it there first, within
    /// 60 seconds, is signed in as the Owner. Only its hash is kept, in
    /// memory, so a restart drops it.
    #[must_use]
    pub fn mint(&self) -> String {
        let code = generate_owner_sign_in_code();
        self.codes.insert(&code, Utc::now());
        code
    }
}
