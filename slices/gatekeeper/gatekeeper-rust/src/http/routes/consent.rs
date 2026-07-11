//! Shared consent machinery for the two Owner consent surfaces —
//! `/oauth-consents/{id}` (authorization-code flow) and `/devices/{userCode}`
//! (device-code flow, RFC 8628). NOT a router: the wire shapes the two flows
//! agree on live in [`crate::http::wire_representations`], and the one behaviour
//! they share — the deny path — lives here.
//!
//! `deny_consent` stays in the HTTP layer rather than moving to `domain`: it
//! renders an axum [`Json`] result, maps store failures to [`HandlerError`], and
//! republishes the active device-consent head off [`AppState`], so it is
//! transport/state machinery, not a pure domain rule.

use axum::Json;

use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;
use crate::http::wire_representations::ConsentResult;

/// Mark the pending request `request_id` denied and return the Owner-UI
/// result. Each flow loads/validates the request with its own loader first,
/// then funnels both the explicit-deny route and the nothing-granted route of
/// `approve` through here, so the deny side stays identical across both trees.
///
/// Also republishes the active device-consent head: a device-flow deny
/// may have just resolved the popup's head, so the modal needs to close
/// (or jump to the next queued request). Code-flow denies are no-ops
/// against the device-only query, so the call is safe to make here
/// unconditionally rather than threading a `grant_type` argument.
pub(crate) fn deny_consent(
    state: &AppState,
    request_id: &str,
) -> Result<Json<ConsentResult>, HandlerError> {
    state
        .store
        .deny_authorization_request(request_id)
        .map_err(|e| HandlerError::internal("deny_authorization_request failed", e))?;
    state.republish_active_device_user_code();
    Ok(Json(ConsentResult::Denied))
}
