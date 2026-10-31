//! [`ClaimedSessionWidening`] — the authority a widened browser session's
//! new token is minted under: a session widening the Owner approved, claimed
//! once by the limited page of the browser whose session it widened. Only
//! that browser's session cookie names the session the widening was asked in,
//! so the claim is proof that the browser now polling is the one the Owner
//! widened. The token is issued to the browser-session client
//! ([`BROWSER_SESSION_CLIENT_ID`]), names the same session as its `sid`, and
//! carries what the session holds now, as its row records it.

use chrono::{DateTime, Utc};

use crate::domain::authorization_request::session_widening::SessionWideningRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, StaleSessionCutoff};
use crate::domain::grant_store::{AuthorizationRequestsTx, BrowserSessionsTx};
use crate::BROWSER_SESSION_CLIENT_ID;

/// An approved session widening, atomically claimed (`approved` → `claimed`)
/// so it mints one wider token at most. Carries the widened session as it
/// stands, which the minter mints under.
pub(crate) struct ClaimedSessionWidening {
    /// The widened session, live when the claim landed: the token's `scope`,
    /// `sid` and expiry are read off it.
    session: BrowserSession,
}

impl ClaimedSessionWidening {
    /// Claim `widening_request`, as read, in the caller's write scope `tx`.
    /// When this call wins the claim, the proof holds the session the
    /// widening widened, as its row stands at `now`. `None` when the widening
    /// isn't approved and unexpired, its session has ended (or is stale under
    /// `stale_session_cutoff`), or a concurrent poll claimed it first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn claim(
        tx: &mut (impl AuthorizationRequestsTx + BrowserSessionsTx),
        widening_request: &SessionWideningRequest,
        stale_session_cutoff: &StaleSessionCutoff,
        now: DateTime<Utc>,
    ) -> Result<Option<Self>, AuthorizationServerError> {
        let Ok(claimed) = widening_request.claim(now) else {
            return Ok(None);
        };
        let Some(session) = tx
            .browser_session_by_sid(&widening_request.sid)?
            .filter(|session| session.is_live_at(now, stale_session_cutoff))
        else {
            return Ok(None);
        };
        if !tx.replace_session_widening_request(widening_request, &claimed)? {
            return Ok(None);
        }
        Ok(Some(ClaimedSessionWidening { session }))
    }

    /// The browser-session client, the token's `sub`.
    pub(super) fn client_id(&self) -> &str {
        BROWSER_SESSION_CLIENT_ID
    }

    /// What the widened session holds, the token's `scope`.
    pub(super) fn token_scopes(&self) -> &[String] {
        &self.session.scopes
    }

    /// The widened session: the token's `sid`, and when it ends, which the
    /// token's lifetime matches.
    pub(crate) fn session(&self) -> &BrowserSession {
        &self.session
    }
}
