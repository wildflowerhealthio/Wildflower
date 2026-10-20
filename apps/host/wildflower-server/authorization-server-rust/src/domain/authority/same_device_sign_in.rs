//! [`RedeemedSameDeviceSignInCode`] — the authority a same-device session's
//! token is minted under: a same-device sign-in code the base minted
//! in-process, presented once and in time at `GET /oauth/sign-in`. Only the
//! base can mint a code, and the base runs on the device that runs the server,
//! so redeeming one is proof of that device. The token it earns is the
//! Owner's, issued to the browser-session client
//! ([`BROWSER_SESSION_CLIENT_ID`]) and holding the Owner's grant
//! ([`OWNER_SCOPES`](crate::OWNER_SCOPES)), with which the Owner decides
//! consents on the server's own consent pages. Redeeming a code starts a
//! same-device session, which the token names as its `sid`.

use chrono::{DateTime, Duration, Utc};
use wildflowerhealthio_scopes::Grant;

use crate::domain::browser_session::BrowserSession;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::BROWSER_SESSION_CLIENT_ID;

/// A sign-in code taken out of the outstanding codes, unexpired. Carries the
/// same-device session the sign-in starts, holding the Owner's grant, which
/// the minter records verbatim.
pub(crate) struct RedeemedSameDeviceSignInCode {
    session: BrowserSession,
}

impl RedeemedSameDeviceSignInCode {
    /// Take `presented` out of `codes` at `now`. When it was outstanding and
    /// unexpired, the proof holds a new same-device session with
    /// `owner_grant`, lasting `session_ttl`; an unknown, spent or expired code
    /// is `None`, the three alike.
    pub(crate) fn redeem(
        codes: &SameDeviceSignInCodes,
        presented: &str,
        owner_grant: &Grant,
        session_ttl: Duration,
        now: DateTime<Utc>,
    ) -> Option<Self> {
        codes
            .take(presented, now)
            .then(|| RedeemedSameDeviceSignInCode {
                session: BrowserSession::new_same_device_session(
                    owner_grant.render(),
                    session_ttl,
                    now,
                ),
            })
    }

    /// The browser-session client, the token's `sub`.
    pub(super) fn client_id(&self) -> &str {
        BROWSER_SESSION_CLIENT_ID
    }

    /// The Owner's grant, the token's `scope`.
    pub(super) fn token_scopes(&self) -> &[String] {
        &self.session.scopes
    }

    /// The same-device session the sign-in starts: the token's `sid`, and
    /// the row the session writer stores.
    pub(crate) fn session(&self) -> &BrowserSession {
        &self.session
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::browser_session::BrowserSessionKind;

    const SESSION_TTL: Duration = Duration::hours(8);

    fn owner_grant() -> Grant {
        Grant::parse(["system/*.cruds", "wildflower/*.cruds"])
    }

    #[test]
    fn a_redeemed_code_names_the_browser_session_client_and_the_owner_s_grant() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        let redeemed = RedeemedSameDeviceSignInCode::redeem(
            &codes,
            "code-1",
            &owner_grant(),
            SESSION_TTL,
            now,
        )
        .expect("an outstanding code redeems");
        assert_eq!(redeemed.client_id(), BROWSER_SESSION_CLIENT_ID);
        assert_eq!(
            redeemed.token_scopes(),
            ["system/*.cruds".to_owned(), "wildflower/*.cruds".to_owned()]
        );
        let session = redeemed.session();
        assert_eq!(session.kind, BrowserSessionKind::SameDevice);
        assert_eq!(session.name, None);
        assert_eq!(session.scopes, redeemed.token_scopes());
        assert_eq!(session.created_at, now);
        assert_eq!(session.expires_at, now + SESSION_TTL);
    }

    #[test]
    fn a_code_redeems_once() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        assert!(RedeemedSameDeviceSignInCode::redeem(
            &codes,
            "code-1",
            &owner_grant(),
            SESSION_TTL,
            now
        )
        .is_some());
        assert!(RedeemedSameDeviceSignInCode::redeem(
            &codes,
            "code-1",
            &owner_grant(),
            SESSION_TTL,
            now
        )
        .is_none());
    }
}
