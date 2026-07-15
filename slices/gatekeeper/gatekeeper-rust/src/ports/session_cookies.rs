//! [`SessionCookies`] — the seam the logout handler clears the owner session
//! through, so the `wf_auth` cookie format stays behind one trait (mirroring how
//! `apps-rust`'s `LaunchCookies` keeps the cookie builder out of that slice).

use axum::http::HeaderMap;

/// Clear the owner session cookies on an outgoing response.
pub(crate) trait SessionCookies {
    /// Append the clearing `Set-Cookie`s for both owner session cookies
    /// (`wf_auth` + `wf_auth_exp`) onto `headers`. `secure` must match the set
    /// form's `Secure` so Safari accepts the clear over http loopback too.
    fn append_clear_session(&self, headers: &mut HeaderMap, secure: bool);
}
