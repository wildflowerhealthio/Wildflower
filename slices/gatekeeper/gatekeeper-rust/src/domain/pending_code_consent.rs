//! [`PendingCodeConsent`] — a validated, ready-to-act authorization-code consent
//! request. It is produced by
//! [`actions::load_pending_authorization_code_request`](crate::domain::actions::load_pending_authorization_code_request)
//! (the only way to build one), which proves the request is `Pending`, an
//! `AuthorizationCode` flow, unexpired, and carries both a `redirect_uri` and a
//! PKCE `code_challenge` — then unwraps those two optionals once here so handlers
//! never re-prove them (parse-don't-validate).

use url::Url;

use crate::domain::authorization_request::AuthorizationRequest;

/// A pending authorization-code consent request that has already passed the
/// loader's validation: it's `Pending`, an `AuthorizationCode` grant flow,
/// unexpired, and carries both a `redirect_uri` and a PKCE `code_challenge`.
/// Those two are unwrapped once at load time so handlers never re-prove them
/// (parse-don't-validate).
#[derive(Debug, PartialEq)]
pub struct PendingCodeConsent {
    pub request: AuthorizationRequest,
    pub redirect_uri: Url,
    pub code_challenge: String,
}
