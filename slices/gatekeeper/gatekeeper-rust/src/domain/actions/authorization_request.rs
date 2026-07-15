//! Authorization-request actions over the [`GatekeeperStore`] port — the request
//! lifecycle relays plus the two semantic consent loaders that validate a request
//! and map an absent/ineligible one onto the domain's `*ConsentNotFound` variants.

use chrono::{DateTime, Utc};

use crate::domain::authorization_code::PendingCodeConsent;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// Load an authorization request by its primary id — a thin relay for callers
/// that apply their own status/flow logic (the device-code token exchange).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_request_by_id(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
    store.authorization_request_by_id(id)
}

/// Load the authorization request behind the `/oauth/authorize/{id}` polling
/// endpoint, mapping an absent row to
/// [`GatekeeperError::AuthorizationRequestNotFound`] — the structured 404 the
/// polling page renders.
///
/// # Errors
///
/// [`GatekeeperError::AuthorizationRequestNotFound`] when no request has this id;
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_request_for_status(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<AuthorizationRequest, GatekeeperError> {
    store
        .authorization_request_by_id(id)?
        .ok_or_else(|| GatekeeperError::AuthorizationRequestNotFound { id: id.to_owned() })
}

/// Look up any authorization request bearing `user_code` — the device-flow
/// user-code uniqueness probe.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_request_by_user_code(
    store: &impl GatekeeperStore,
    user_code: &str,
) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
    store.authorization_request_by_user_code(user_code)
}

/// The `user_code` of the FIFO head of the pending device-code consent queue —
/// the value the host popup advertises.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn oldest_pending_device_user_code(
    store: &impl GatekeeperStore,
) -> Result<Option<String>, GatekeeperError> {
    store.oldest_pending_device_user_code()
}

/// Persist a freshly-constructed authorization request (the store prunes expired
/// rows first).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn insert_authorization_request(
    store: &impl GatekeeperStore,
    request: &AuthorizationRequest,
) -> Result<(), GatekeeperError> {
    store.insert_authorization_request(request)
}

/// Mark a pending request approved, returning `true` iff a pending row was
/// transitioned (the callers turn `false` into their own flow-specific
/// response).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn approve_authorization_request(
    store: &impl GatekeeperStore,
    id: &str,
    granted_scopes: &[String],
    patient: Option<&str>,
    device_name: Option<&str>,
) -> Result<bool, GatekeeperError> {
    store.approve_authorization_request(id, granted_scopes, patient, device_name)
}

/// Mark a request denied.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn deny_authorization_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<(), GatekeeperError> {
    store.deny_authorization_request(id)
}

/// Atomically claim an approved device request for single-use redemption,
/// returning `true` iff this call won the race.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn consume_approved_authorization_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<bool, GatekeeperError> {
    store.consume_approved_authorization_request(id)
}

/// Stamp a device request's `last_polled_at`.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn record_device_poll(
    store: &impl GatekeeperStore,
    id: &str,
    polled_at: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.record_device_poll(id, polled_at)
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
/// well-formed code-flow request has this id; [`GatekeeperError::Infrastructure`]
/// when the store read fails.
pub(crate) fn load_pending_authorization_code_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<PendingCodeConsent, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
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
                (Some(redirect_uri), Some(code_challenge)) => Ok(PendingCodeConsent {
                    request: r,
                    redirect_uri,
                    code_challenge,
                }),
                _ => Err(make_consent_not_found()),
            }
        }
        _ => Err(make_consent_not_found()),
    }
}

/// Load the authorization request for `user_code` and verify it's a pending,
/// unexpired device-code flow.
///
/// # Errors
///
/// [`GatekeeperError::DeviceConsentNotFound`] when no pending, unexpired
/// device-flow request has this user code; [`GatekeeperError::Infrastructure`]
/// when the store read fails.
pub(crate) fn load_pending_device_request(
    store: &impl GatekeeperStore,
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

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::super::test_fake::{code_request, device_request, FakeGatekeeperStore};
    use super::*;

    #[test]
    fn authorization_request_for_status_maps_absence_to_not_found() {
        let store = FakeGatekeeperStore::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        assert_eq!(
            authorization_request_for_status(&store, "req-1")
                .unwrap()
                .id,
            "req-1"
        );
        assert_eq!(
            authorization_request_for_status(&store, "ghost"),
            Err(GatekeeperError::AuthorizationRequestNotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn load_pending_code_request_accepts_a_live_request_and_unwraps_its_fields() {
        let store = FakeGatekeeperStore::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let loaded =
            load_pending_authorization_code_request(&store, "req-1").expect("live request");
        assert_eq!(loaded.request.id, "req-1");
        assert_eq!(loaded.redirect_uri.as_str(), "https://example.com/cb");
        assert_eq!(loaded.code_challenge.len(), 43);
    }

    #[test]
    fn load_pending_code_request_refuses_non_pending_expired_or_wrong_flow() {
        let store = FakeGatekeeperStore::default();
        // Denied → not found.
        store
            .insert_authorization_request(&code_request(
                "denied",
                RequestStatus::Denied,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        // Pending but expired → not found (read-time deadline).
        store
            .insert_authorization_request(&code_request(
                "expired",
                RequestStatus::Pending,
                Utc::now() - Duration::minutes(1),
            ))
            .unwrap();
        // A pending device-code row → not found on the code-flow loader.
        store
            .insert_authorization_request(&device_request("device", "UC-1", RequestStatus::Pending))
            .unwrap();
        for id in ["denied", "expired", "device", "ghost"] {
            assert_eq!(
                load_pending_authorization_code_request(&store, id),
                Err(GatekeeperError::OAuthConsentNotFound { id: id.to_owned() }),
                "{id} must be OAuthConsentNotFound",
            );
        }
    }

    #[test]
    fn load_pending_device_request_accepts_live_and_refuses_the_rest() {
        let store = FakeGatekeeperStore::default();
        store
            .insert_authorization_request(&device_request(
                "dev-1",
                "LIVE-1",
                RequestStatus::Pending,
            ))
            .unwrap();
        store
            .insert_authorization_request(&device_request(
                "dev-2",
                "DENIED-1",
                RequestStatus::Denied,
            ))
            .unwrap();
        assert_eq!(
            load_pending_device_request(&store, "LIVE-1").unwrap().id,
            "dev-1"
        );
        for user_code in ["DENIED-1", "UNKNOWN"] {
            assert_eq!(
                load_pending_device_request(&store, user_code),
                Err(GatekeeperError::DeviceConsentNotFound {
                    user_code: user_code.to_owned()
                }),
            );
        }
    }
}
