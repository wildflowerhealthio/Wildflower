//! [`RedeemedSameDeviceSignInCode`] — the authority an Owner browser's
//! session token is minted under: a same-device sign-in code the base minted
//! in-process, presented once and in time at `GET /oauth/sign-in`. Only the
//! base can mint a code, and the base runs on the device that runs the server,
//! so redeeming one is proof of that device. The token it earns is the
//! Owner's, issued to the Owner-browser client
//! ([`OWNER_BROWSER_CLIENT_ID`]) and holding the host Owner's grant, the grant
//! the host's own owner token and the
//! [`HostConsentDecider`](crate::HostConsentDecider) act under.

use chrono::{DateTime, Utc};
use wildflowerhealthio_scopes::Grant;

use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::OWNER_BROWSER_CLIENT_ID;

/// A sign-in code taken out of the outstanding codes, unexpired. Carries the
/// Owner's grant, which the minter records verbatim.
pub(crate) struct RedeemedSameDeviceSignInCode {
    token_scopes: Vec<String>,
}

impl RedeemedSameDeviceSignInCode {
    /// Take `presented` out of `codes` at `now`. When it was outstanding and
    /// unexpired, the proof holds `owner_grant`; an unknown, spent or expired
    /// code is `None`, the three alike.
    pub(crate) fn redeem(
        codes: &SameDeviceSignInCodes,
        presented: &str,
        owner_grant: &Grant,
        now: DateTime<Utc>,
    ) -> Option<Self> {
        codes
            .take(presented, now)
            .then(|| RedeemedSameDeviceSignInCode {
                token_scopes: owner_grant.render(),
            })
    }

    /// The Owner-browser client, the token's `sub`.
    pub(super) fn client_id(&self) -> &str {
        OWNER_BROWSER_CLIENT_ID
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
    fn a_redeemed_code_names_the_owner_browser_client_and_the_owner_s_grant() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        let redeemed = RedeemedSameDeviceSignInCode::redeem(&codes, "code-1", &owner_grant(), now)
            .expect("an outstanding code redeems");
        assert_eq!(redeemed.client_id(), "wildflower-owner-browser");
        assert_eq!(
            redeemed.token_scopes(),
            ["system/*.cruds".to_owned(), "wildflower/*.cruds".to_owned()]
        );
    }

    #[test]
    fn a_code_redeems_once() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        assert!(
            RedeemedSameDeviceSignInCode::redeem(&codes, "code-1", &owner_grant(), now).is_some()
        );
        assert!(
            RedeemedSameDeviceSignInCode::redeem(&codes, "code-1", &owner_grant(), now).is_none()
        );
    }
}
