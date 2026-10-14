//! The cookie a browser holds its Owner browser session in once it has signed in at
//! `/oauth/sign-in`: `__Host-owner_browser_session`, whose value is the Owner's access
//! token itself. The server keeps no session table, so a restart doesn't sign
//! the Owner out; revoking the token's `jti` does.
//!
//! The authorization server only sets it. The host's cookie→bearer layer
//! (`wildflower-server-rust`'s `session_cookie_bearer`) reads it back on
//! requests from the server's own pages and presents its value as the
//! request's bearer, so the bearer gates check it like any other token.

use crate::domain::capabilities::oauth::OWNER_BROWSER_SESSION_TTL;

/// The Owner browser session cookie. The `__Host-` prefix holds a browser to
/// accepting it only `Secure`, with `Path=/` and no `Domain`, so it is this
/// server's alone, set over `https`, and no sibling subdomain can set or
/// shadow it.
pub const OWNER_BROWSER_SESSION_COOKIE: &str = "__Host-owner_browser_session";

/// The `Set-Cookie` value that hands a browser `owner_access_token` as its
/// Owner browser session: `HttpOnly`, so no script reads it; `SameSite=Lax`, so
/// another site's subrequests don't carry it; and it lasts exactly as long as
/// the token.
pub(crate) fn owner_browser_session_set_cookie(owner_access_token: &str) -> String {
    format!(
        "{OWNER_BROWSER_SESSION_COOKIE}={owner_access_token}; Secure; HttpOnly; SameSite=Lax; Path=/; \
         Max-Age={}",
        OWNER_BROWSER_SESSION_TTL.num_seconds()
    )
}

#[cfg(test)]
mod tests {
    use super::owner_browser_session_set_cookie;

    #[test]
    fn the_cookie_has_exactly_the_owner_browser_session_attributes() {
        assert_eq!(
            owner_browser_session_set_cookie("header.payload.signature"),
            "__Host-owner_browser_session=header.payload.signature; Secure; HttpOnly; SameSite=Lax; \
             Path=/; Max-Age=28800"
        );
    }
}
