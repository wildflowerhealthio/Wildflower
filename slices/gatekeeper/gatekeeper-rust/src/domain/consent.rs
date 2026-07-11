//! Pending-consent loaders shared by the Owner consent surfaces — HTTP-pure:
//! they take the store, return domain types, and fail with
//! [`GatekeeperError`]; no axum or HTTP types. The route trees
//! (`http/routes/oauth_consents`, `http/routes/devices`) call these and `?`
//! the error straight into their response rendering.

use chrono::Utc;
use url::Url;

use crate::db::GatekeeperStore;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::error::GatekeeperError;
use persistence_rust::UriColumn;

/// A pending authorization-code consent request that has already passed the
/// loader's validation: it's `Pending`, an `AuthorizationCode` grant flow,
/// unexpired, and carries both a `redirect_uri` and a PKCE `code_challenge`.
/// Those two are unwrapped once here so handlers never re-prove them
/// (parse-don't-validate).
pub struct PendingCodeConsent {
    pub request: AuthorizationRequest,
    pub redirect_uri: Url,
    pub code_challenge: String,
}

/// Load the authorization request for `id` and verify it's a pending,
/// unexpired authorization-code flow carrying both a `redirect_uri` and a
/// PKCE `code_challenge`. On success the two optional fields are unwrapped
/// into the returned [`PendingCodeConsent`] so callers never re-prove them
/// (parse-don't-validate). A request whose `expires_at` has passed
/// (`AUTHORIZATION_REQUEST_TTL`, 5 min) is treated as not found — nothing
/// actively transitions code-flow requests to `Expired`, so the deadline is
/// enforced here at read time.
///
/// # Errors
///
/// [`GatekeeperError::OAuthConsentNotFound`] when no pending, unexpired,
/// well-formed code-flow request has this id; [`GatekeeperError::Backend`]
/// when the store read fails.
pub fn load_pending_authorization_code_request(
    store: &GatekeeperStore,
    id: &str,
) -> Result<PendingCodeConsent, GatekeeperError> {
    let consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
    match store.authorization_request_by_id(id)? {
        Some(r)
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.expires_at > Utc::now() =>
        {
            // For a code-flow request both fields are populated by
            // `new_code_authorization`; if either is somehow absent the row is
            // malformed and we refuse it rather than panic.
            match (r.redirect_uri.clone(), r.code_challenge.clone()) {
                (Some(UriColumn(redirect_uri)), Some(code_challenge)) => Ok(PendingCodeConsent {
                    request: r,
                    redirect_uri,
                    code_challenge,
                }),
                _ => Err(consent_not_found()),
            }
        }
        _ => Err(consent_not_found()),
    }
}

/// Load the authorization request for `user_code` and verify it's a pending,
/// unexpired device-code flow.
///
/// # Errors
///
/// [`GatekeeperError::DeviceConsentNotFound`] when no pending, unexpired
/// device-flow request has this user code; [`GatekeeperError::Backend`] when
/// the store read fails.
pub fn load_pending_device_request(
    store: &GatekeeperStore,
    user_code: &str,
) -> Result<AuthorizationRequest, GatekeeperError> {
    match store.pending_authorization_request_by_user_code(user_code)? {
        Some(r)
            if r.grant_type == GrantType::DeviceCode
                && r.status == RequestStatus::Pending
                && r.expires_at > Utc::now() =>
        {
            Ok(r)
        }
        _ => Err(GatekeeperError::DeviceConsentNotFound {
            user_code: user_code.to_owned(),
        }),
    }
}
