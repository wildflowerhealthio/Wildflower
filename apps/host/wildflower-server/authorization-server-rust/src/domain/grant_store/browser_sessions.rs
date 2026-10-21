//! [`BrowserSessionsTx`] — the `browser_sessions` table, and the clients each
//! session has gone on past its limited page for.

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, BrowserSessionKind};

/// The browser sessions the server has signed in. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
pub trait BrowserSessionsTx {
    /// Persist a freshly started browser session.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the `sid`).
    fn insert_browser_session(
        &mut self,
        session: &BrowserSession,
    ) -> Result<(), AuthorizationServerError>;

    /// Load the browser session `sid`, or `None` when no session has it.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or the returned row
    /// cannot be mapped to a [`BrowserSession`].
    fn browser_session_by_sid(
        &mut self,
        sid: &str,
    ) -> Result<Option<BrowserSession>, AuthorizationServerError>;

    /// Every browser session live at `now`: not revoked, and expiring after
    /// `now`. Newest first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a row
    /// cannot be mapped to a [`BrowserSession`].
    fn live_browser_sessions(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Vec<BrowserSession>, AuthorizationServerError>;

    /// Whether the browser session `sid` has been revoked, without loading
    /// it. A `sid` that names no session counts as revoked: a session is
    /// pruned only once nothing it minted can still be live, so a missing row
    /// fails closed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails.
    fn is_browser_session_revoked(&mut self, sid: &str) -> Result<bool, AuthorizationServerError>;

    /// Stamp the browser session `sid` revoked at `now`, returning `true` iff a
    /// session that wasn't already revoked was transitioned. The row is kept.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn revoke_browser_session(
        &mut self,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Expire the browser session `sid` at `now`: its `expires_at` moves to
    /// `now`, unless it is already at or before `now`, returning `true` iff it
    /// moved. The row is kept, and isn't revoked.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn expire_browser_session(
        &mut self,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Expire, at `now`, every browser session of `kind` expiring after `now`,
    /// as [`expire_browser_session`](Self::expire_browser_session) does one,
    /// returning how many moved.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn expire_browser_sessions_of_kind(
        &mut self,
        kind: BrowserSessionKind,
        now: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;

    /// Move the browser session `sid`'s `last_seen_at` to `seen_at`, unless
    /// it was last seen after `seen_before`, returning `true` iff it
    /// moved. A `sid` with no row moves nothing. Moved when the session's
    /// cookie is accepted and by a refresh-token rotation under the session.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn touch_browser_session_last_seen(
        &mut self,
        sid: &str,
        seen_at: DateTime<Utc>,
        seen_before: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Whether the browser session `sid` has gone on past its limited page
    /// for `client_id` before.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails.
    fn is_session_shortfall_acknowledged_for_client(
        &mut self,
        sid: &str,
        client_id: &str,
    ) -> Result<bool, AuthorizationServerError>;

    /// Record that the browser session `sid` went on past its limited page
    /// for `client_id`, so its later requests for that client skip the page.
    /// Recording it again changes nothing.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails.
    fn record_session_shortfall_acknowledgement(
        &mut self,
        sid: &str,
        client_id: &str,
    ) -> Result<(), AuthorizationServerError>;

    /// Delete every browser session that expired or was revoked before
    /// `cutoff` and that no refresh-token family alive at `cutoff` names,
    /// returning how many went.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_browser_sessions_ended_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;
}
