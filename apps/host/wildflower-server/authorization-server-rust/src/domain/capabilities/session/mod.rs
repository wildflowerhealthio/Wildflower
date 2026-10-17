//! The **session** capabilities — the caller acting on their *own* verified
//! token, and the verification that produces it:
//!
//!  - [`TokenVerifier`] — the access-token verification policy both authN
//!    gates run (signature, `iss` and `aud` against the server's origin,
//!    revocation last).
//!  - [`BrowserSessionUseRecorder`] — the host's cookie→bearer layer
//!    recording that it accepted a browser session's cookie, which moves the
//!    session's `last_seen_at`.
//!  - [`SessionEnder`] and [`SessionReader`] — authenticated-only (no scope):
//!    logout's self-revoke and reading back one's own scopes, acquired through
//!    the shared `Authenticated<F>` extractor. A scope gate here would lock out
//!    exactly the under-scoped callers who need them.

mod browser_session_use_recorder;
mod session_ender;
mod session_reader;
mod token_verifier;

pub(crate) use browser_session_use_recorder::BrowserSessionUseRecorder;
pub(crate) use session_ender::SessionEnder;
pub(crate) use session_reader::SessionReader;
pub(crate) use token_verifier::TokenVerifier;
