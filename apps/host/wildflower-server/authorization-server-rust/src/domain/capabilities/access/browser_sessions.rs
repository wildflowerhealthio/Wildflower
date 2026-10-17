//! Browser-session capabilities — the `wildflower/BrowserSession.*`
//! capabilities behind `/authorization/browser-sessions[/{sid}]`: list the
//! browsers the server has signed in, and revoke one.

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

/// The scope gating the browser-session reader — `wildflower/BrowserSession.r`.
pub(crate) fn browser_sessions_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::BrowserSession,
        Permission::READ,
    )]
}

/// The scope gating the browser-session revoker — `wildflower/BrowserSession.d`.
pub(crate) fn browser_sessions_revoker_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::BrowserSession,
        Permission::DELETE,
    )]
}
