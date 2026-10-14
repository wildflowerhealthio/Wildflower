//! [`RedeemedOwnerSignInCode`] — the authority an Owner's session token is
//! minted under: a sign-in code the base minted in-process, presented once and
//! in time at `GET /oauth/sign-in`. Only the base can mint a code, and the
//! base runs on the device that runs the server, so redeeming one is proof of
//! that device. The token it earns is the Owner's: the first-party client
//! holding the host Owner's grant, the client and grant the host's own owner
//! token and the [`HostConsentDecider`](crate::HostConsentDecider) act as.

use chrono::{DateTime, Utc};
use wildflowerhealthio_scopes::Grant;

use crate::domain::owner_sign_in_codes::OwnerSignInCodes;

/// A sign-in code taken out of the outstanding codes, unexpired. Carries the
/// Owner's client and grant, which the minter records verbatim.
pub(crate) struct RedeemedOwnerSignInCode {
    client_id: String,
    token_scopes: Vec<String>,
}

impl RedeemedOwnerSignInCode {
    /// Take `presented` out of `codes` at `now`. When it was outstanding and
    /// unexpired, the proof names `owner_client_id` holding `owner_grant`;
    /// an unknown, spent or expired code is `None`, the three alike.
    pub(crate) fn redeem(
        codes: &OwnerSignInCodes,
        presented: &str,
        owner_client_id: &str,
        owner_grant: &Grant,
        now: DateTime<Utc>,
    ) -> Option<Self> {
        codes.take(presented, now).then(|| RedeemedOwnerSignInCode {
            client_id: owner_client_id.to_owned(),
            token_scopes: owner_grant.render(),
        })
    }

    /// The Owner's client, the token's `sub`.
    pub(super) fn client_id(&self) -> &str {
        &self.client_id
    }

    /// The Owner's grant, the token's `scope`.
    pub(super) fn token_scopes(&self) -> &[String] {
        &self.token_scopes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_grant() -> Grant {
        Grant::parse(["system/*.cruds", "wildflower/*.cruds"])
    }

    #[test]
    fn a_redeemed_code_names_the_owner_and_their_grant() {
        let codes = OwnerSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        let redeemed =
            RedeemedOwnerSignInCode::redeem(&codes, "code-1", "host", &owner_grant(), now)
                .expect("an outstanding code redeems");
        assert_eq!(redeemed.client_id(), "host");
        assert_eq!(
            redeemed.token_scopes(),
            ["system/*.cruds".to_owned(), "wildflower/*.cruds".to_owned()]
        );
    }

    #[test]
    fn a_code_redeems_once() {
        let codes = OwnerSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        assert!(
            RedeemedOwnerSignInCode::redeem(&codes, "code-1", "host", &owner_grant(), now)
                .is_some()
        );
        assert!(
            RedeemedOwnerSignInCode::redeem(&codes, "code-1", "host", &owner_grant(), now)
                .is_none()
        );
    }
}
