//! The **redemption proofs** — what an [`AuthenticatedClient`] must hold before
//! an access token is minted for it at `/oauth/token`. Each stands for one
//! grant type (RFC 6749 §4.1.3, RFC 8628 §3.4, RFC 6749 §6) and its one
//! constructor is the whole redemption rule: the atomic single-use claim, the
//! client / redirect / expiry bindings, the PKCE check. The scopes each carries
//! are copied from the record it redeemed, so the token the minter signs can
//! only ever hold what the standing consent behind that record recorded.
//!
//!  - [`RedeemedAuthorizationCode`] — the code consumed and bound.
//!  - [`ConsumedDeviceRequest`] — the approved device request claimed.
//!  - [`ValidatedRefreshToken`] — a live refresh token bound to its client. It
//!    is *validated*, not yet rotated, on purpose: the flow mints first and
//!    rotates after, so a signing failure never burns the presented token.
//!
//! [`GrantRedemption`] marks the two that may also start a refresh-token
//! family (a refresh can only rotate the family it belongs to).

use chrono::{DateTime, Utc};
use subtle::ConstantTimeEq;
use url::Url;

use super::authenticated_client::AuthenticatedClient;
use super::mint_authority::{sealed, MintAuthority};
use crate::crypto_util::pkce::compute_code_challenge;
use crate::crypto_util::random_token::token_storage_hash;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{
    AuthorizationRequest, GrantType, RequestStatus, DEVICE_CODE_POLL_INTERVAL,
};
use crate::domain::refresh_token::RefreshTokenFamily;
use crate::domain::token_exchange_error::{InvalidGrantReason, TokenExchangeError};
use crate::domain::GatekeeperStore;

/// The presented halves of an authorization-code redemption (RFC 6749 §4.1.3).
pub(crate) struct CodeRedemption<'a> {
    pub(crate) code: &'a str,
    pub(crate) code_verifier: &'a str,
    pub(crate) redirect_uri: &'a Url,
}

/// A redemption that may start a refresh-token family: the two grants that
/// establish a session rather than renew one. Sealed like [`MintAuthority`].
pub(crate) trait GrantRedemption: MintAuthority {
    /// The scopes as granted (before the minter's spelling twin), for the
    /// token response's `scope` and the family's record.
    fn granted_scopes(&self) -> &[String];
    /// The authorization code this redemption consumed, so a later replay of
    /// that code can revoke the family it started; `None` for the device flow.
    fn authorization_code(&self) -> Option<&str>;
    /// The standing grant behind this redemption, if one was resolved.
    fn grant_id(&self) -> Option<&str>;
}

/// An authorization code that has been atomically consumed and verified: bound
/// to the redeeming client and `redirect_uri`, unexpired, and matching the
/// PKCE verifier. Carries the code's granted scopes.
pub(crate) struct RedeemedAuthorizationCode {
    code: AuthorizationCode,
    token_scopes: Vec<String>,
    grant_id: Option<String>,
}

impl RedeemedAuthorizationCode {
    /// Atomically read-and-consume the code, then verify every binding. A code
    /// that is gone (redeemed or never issued) is a possible replay: any refresh
    /// family minted from it is revoked before the refusal (RFC 6749 §4.1.2).
    /// The binding failures all collapse to `invalid_grant` on the wire (the
    /// reason is logged), so a response never reveals which check failed.
    ///
    /// # Errors
    ///
    /// [`TokenExchangeError::InvalidGrant`] with the specific reason;
    /// [`TokenExchangeError::Store`] on a store failure.
    pub(crate) fn redeem(
        store: &impl GatekeeperStore,
        client: &AuthenticatedClient,
        redemption: &CodeRedemption<'_>,
        now: DateTime<Utc>,
    ) -> Result<Self, TokenExchangeError> {
        // A concurrent redemption of the same code can only succeed once, so
        // any racer past this point sees `None` (RFC 6749 §10.5).
        let Some(code) = store.redeem_authorization_code(redemption.code)? else {
            store.expire_refresh_token_families_for_authorization_code(
                &token_storage_hash(redemption.code),
                now,
            )?;
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::CodeNotFoundOrRedeemed,
            ));
        };
        if code.client_id != client.client_id() {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::CodeClientMismatch {
                    code_client_id: code.client_id,
                    presented_client_id: client.client_id().to_owned(),
                },
            ));
        }
        if code.redirect_uri != *redemption.redirect_uri {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::CodeRedirectMismatch {
                    code_redirect_uri: code.redirect_uri.to_string(),
                    presented_redirect_uri: redemption.redirect_uri.to_string(),
                },
            ));
        }
        if code.expires_at < now {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::CodeExpired {
                    expires_at: code.expires_at,
                },
            ));
        }
        let computed = compute_code_challenge(redemption.code_verifier);
        if !bool::from(code.code_challenge.as_bytes().ct_eq(computed.as_bytes())) {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::PkceMismatch {
                    client_id: client.client_id().to_owned(),
                },
            ));
        }
        // The standing grant behind this exchange, recorded on the family
        // (write-only in v1); a grant revoked between approval and redemption
        // just leaves it `None`.
        let grant_id = store
            .grant_by_client_and_redirect(client.client_id(), redemption.redirect_uri)?
            .map(|grant| grant.id);
        Ok(RedeemedAuthorizationCode {
            token_scopes: token_scope_spellings(&code.granted_scopes),
            code,
            grant_id,
        })
    }
}

impl sealed::Sealed for RedeemedAuthorizationCode {}

impl MintAuthority for RedeemedAuthorizationCode {
    fn client_id(&self) -> &str {
        &self.code.client_id
    }

    fn scopes(&self) -> &[String] {
        &self.token_scopes
    }

    fn patient(&self) -> Option<&str> {
        self.code.patient.as_deref()
    }

    fn is_host_owner(&self) -> bool {
        false
    }
}

impl GrantRedemption for RedeemedAuthorizationCode {
    fn granted_scopes(&self) -> &[String] {
        &self.code.granted_scopes
    }

    fn authorization_code(&self) -> Option<&str> {
        Some(&self.code.code)
    }

    fn grant_id(&self) -> Option<&str> {
        self.grant_id.as_deref()
    }
}

/// An approved device request that this poll has atomically claimed (RFC 8628
/// §3.4 single use), bound to the polling client. Carries the scopes the Owner
/// granted at approval.
pub(crate) struct ConsumedDeviceRequest {
    request: AuthorizationRequest,
    granted_scopes: Vec<String>,
    token_scopes: Vec<String>,
    grant_id: Option<String>,
}

impl ConsumedDeviceRequest {
    /// Resolve the device request for `device_code`, require it to be this
    /// client's, unexpired, and approved (stamping the poll and throttling a
    /// still-pending one per §3.5), then atomically claim it. The status read
    /// is advisory; the `approved` → `expired` claim is the real single-use
    /// gate, so two concurrent polls can't both mint.
    ///
    /// # Errors
    ///
    /// The §3.5 poll outcomes ([`ExpiredToken`](TokenExchangeError::ExpiredToken),
    /// [`AuthorizationPending`](TokenExchangeError::AuthorizationPending),
    /// [`AccessDenied`](TokenExchangeError::AccessDenied),
    /// [`SlowDown`](TokenExchangeError::SlowDown)),
    /// [`TokenExchangeError::InvalidGrant`] for an unknown or already-claimed
    /// request, [`TokenExchangeError::Store`] on a store failure.
    pub(crate) fn consume(
        store: &impl GatekeeperStore,
        client: &AuthenticatedClient,
        device_code: &str,
        now: DateTime<Utc>,
    ) -> Result<Self, TokenExchangeError> {
        let request = match store.authorization_request_by_id(device_code)? {
            Some(record)
                if record.grant_type == GrantType::DeviceCode
                    && record.client_id == client.client_id() =>
            {
                record
            }
            // One outcome collapses "no such device_code", "wrong client", and
            // "not a device request".
            _ => {
                return Err(TokenExchangeError::InvalidGrant(
                    InvalidGrantReason::DeviceRequestNotFound {
                        presented_client_id: client.client_id().to_owned(),
                    },
                ))
            }
        };
        if request.expires_at < now {
            return Err(TokenExchangeError::ExpiredToken);
        }
        if request.status == RequestStatus::Pending {
            if let Some(last_polled) = request.last_polled_at {
                if now - last_polled < DEVICE_CODE_POLL_INTERVAL {
                    return Err(TokenExchangeError::SlowDown);
                }
            }
            store.record_device_poll(&request.id, now)?;
        }
        match request.status {
            RequestStatus::Approved => {}
            RequestStatus::Pending => return Err(TokenExchangeError::AuthorizationPending),
            RequestStatus::Denied => return Err(TokenExchangeError::AccessDenied),
            RequestStatus::Expired => return Err(TokenExchangeError::ExpiredToken),
        }
        if !store.consume_approved_authorization_request(&request.id)? {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::DeviceCodeAlreadyRedeemed {
                    client_id: request.client_id,
                },
            ));
        }
        let granted_scopes = request.granted_scopes.clone().unwrap_or_default();
        // The durable device grant minted at approval is keyed on the
        // *effective* device name — the request's, or the client name it
        // defaulted to — the same fallback the approval recorded under.
        let effective_device_name = request
            .device_name
            .as_deref()
            .unwrap_or(client.client().name.as_str());
        let grant_id = store
            .device_grant_by_client_and_device_name(&request.client_id, effective_device_name)?
            .map(|grant| grant.id);
        Ok(ConsumedDeviceRequest {
            token_scopes: token_scope_spellings(&granted_scopes),
            granted_scopes,
            request,
            grant_id,
        })
    }
}

impl sealed::Sealed for ConsumedDeviceRequest {}

impl MintAuthority for ConsumedDeviceRequest {
    fn client_id(&self) -> &str {
        &self.request.client_id
    }

    fn scopes(&self) -> &[String] {
        &self.token_scopes
    }

    fn patient(&self) -> Option<&str> {
        self.request.patient.as_deref()
    }

    fn is_host_owner(&self) -> bool {
        false
    }
}

impl GrantRedemption for ConsumedDeviceRequest {
    fn granted_scopes(&self) -> &[String] {
        &self.granted_scopes
    }

    fn authorization_code(&self) -> Option<&str> {
        None
    }

    fn grant_id(&self) -> Option<&str> {
        self.grant_id.as_deref()
    }
}

/// A refresh token that resolved to a live family owned by the presenting
/// client (RFC 6749 §6). Not yet consumed: the flow mints against it first and
/// rotates it afterwards through the refresh-family writer, so a signing
/// failure leaves the presented token usable for a retry.
pub(crate) struct ValidatedRefreshToken {
    family: RefreshTokenFamily,
    presented_hash: String,
    token_scopes: Vec<String>,
}

impl ValidatedRefreshToken {
    /// Resolve the presented token's family and require it to be this client's
    /// and unexpired. A valid token presented by the wrong client is answered
    /// exactly like an unknown one so a stranger can't probe validity, and is
    /// refused before any consume so it can't burn the rightful client's token.
    ///
    /// # Errors
    ///
    /// [`TokenExchangeError::InvalidGrant`] with the specific reason;
    /// [`TokenExchangeError::Store`] on a store failure.
    pub(crate) fn validate(
        store: &impl GatekeeperStore,
        client: &AuthenticatedClient,
        presented_refresh_token: &str,
        now: DateTime<Utc>,
    ) -> Result<Self, TokenExchangeError> {
        let presented_hash = token_storage_hash(presented_refresh_token);
        let Some((_, family)) = store.refresh_token_with_family_by_hash(&presented_hash)? else {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenNotFound,
            ));
        };
        if family.client_id != client.client_id() {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenClientMismatch {
                    family_client_id: family.client_id,
                    presented_client_id: client.client_id().to_owned(),
                },
            ));
        }
        // Covers both natural deadline passage and prior revocation — revoking
        // pulls `expires_at` back to the revocation instant rather than
        // deleting rows, so the lineage stays auditable.
        if family.expires_at <= now {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenExpired,
            ));
        }
        Ok(ValidatedRefreshToken {
            token_scopes: token_scope_spellings(&family.scopes),
            family,
            presented_hash,
        })
    }

    /// The family's scopes as granted, for the token response's `scope`.
    pub(crate) fn granted_scopes(&self) -> &[String] {
        &self.family.scopes
    }

    /// The family this token belongs to.
    pub(crate) fn family_id(&self) -> &str {
        &self.family.family_id
    }

    /// The storage hash of the presented token — what rotation consumes.
    pub(crate) fn presented_hash(&self) -> &str {
        &self.presented_hash
    }
}

impl sealed::Sealed for ValidatedRefreshToken {}

impl MintAuthority for ValidatedRefreshToken {
    fn client_id(&self) -> &str {
        &self.family.client_id
    }

    fn scopes(&self) -> &[String] {
        &self.token_scopes
    }

    fn patient(&self) -> Option<&str> {
        self.family.patient.as_deref()
    }

    fn is_host_owner(&self) -> bool {
        false
    }
}

/// The scopes a token carries: each granted scope alongside its alternate
/// canonical form, so a v1-worded grant also carries its v2 letter spelling
/// (see [`scopes_rust::with_alternate_canonical_forms`]). The response's
/// `scope` stays the granted set as-is.
fn token_scope_spellings(granted: &[String]) -> Vec<String> {
    scopes_rust::with_alternate_canonical_forms(granted)
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::crypto_util::random_token::generate_authorization_code;
    use crate::domain::authorization_code::AUTHORIZATION_CODE_TTL;
    use crate::domain::client_credentials::ClientCredentials;
    use crate::domain::refresh_token::RefreshToken;
    use crate::domain::test_fake::{client, device_request, FakeGatekeeperStore};

    fn authenticated(store: &FakeGatekeeperStore, client_id: &str) -> AuthenticatedClient {
        store
            .upsert_client(&client(client_id, &["openid"]))
            .unwrap();
        AuthenticatedClient::authenticate(
            store,
            &ClientCredentials {
                client_id: client_id.to_owned(),
                client_secret: None,
            },
        )
        .expect("public client")
    }

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").unwrap()
    }

    const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-1";

    fn issued_code(store: &FakeGatekeeperStore, client_id: &str, now: DateTime<Utc>) -> String {
        let code = generate_authorization_code();
        store
            .issue_authorization_code(&AuthorizationCode {
                code: code.clone(),
                request_id: "req".to_owned(),
                client_id: client_id.to_owned(),
                redirect_uri: redirect(),
                code_challenge: compute_code_challenge(VERIFIER),
                granted_scopes: vec!["patient/Patient.read".to_owned()],
                patient: Some("pat-1".to_owned()),
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
            })
            .unwrap();
        code
    }

    fn reason(outcome: Result<impl Sized, TokenExchangeError>) -> InvalidGrantReason {
        match outcome {
            Err(TokenExchangeError::InvalidGrant(reason)) => reason,
            Err(other) => panic!("expected InvalidGrant, got {other:?}"),
            Ok(_) => panic!("expected a refusal"),
        }
    }

    /// A bound, unexpired code with the right verifier redeems once: the proof
    /// carries the code's client, patient, and scopes (twinned for the token,
    /// verbatim for the response), and a second redemption is refused.
    #[test]
    fn a_code_redeems_once_with_its_recorded_claims() {
        let store = FakeGatekeeperStore::default();
        let now = Utc::now();
        let client = authenticated(&store, "app");
        let code = issued_code(&store, "app", now);
        let redemption = CodeRedemption {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: &redirect(),
        };
        let proof =
            RedeemedAuthorizationCode::redeem(&store, &client, &redemption, now).expect("redeems");
        assert_eq!(proof.client_id(), "app");
        assert_eq!(proof.patient(), Some("pat-1"));
        assert_eq!(proof.granted_scopes(), ["patient/Patient.read"]);
        assert_eq!(
            proof.scopes(),
            ["patient/Patient.read", "patient/Patient.rs"]
        );
        assert_eq!(proof.authorization_code(), Some(code.as_str()));
        assert_eq!(
            reason(RedeemedAuthorizationCode::redeem(
                &store,
                &client,
                &redemption,
                now
            )),
            InvalidGrantReason::CodeNotFoundOrRedeemed
        );
    }

    /// Each binding refuses with its own reason: wrong client, wrong redirect,
    /// expired, bad verifier. Every refusal consumed the code (redemption is
    /// atomic and first), so none of them can be retried into a token.
    #[test]
    fn a_code_is_refused_for_each_broken_binding() {
        let store = FakeGatekeeperStore::default();
        let now = Utc::now();
        let app = authenticated(&store, "app");
        let other = authenticated(&store, "other");
        let elsewhere = Url::parse("https://elsewhere.example/cb").unwrap();

        let code = issued_code(&store, "app", now);
        let wrong_client = CodeRedemption {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: &redirect(),
        };
        assert!(matches!(
            reason(RedeemedAuthorizationCode::redeem(
                &store,
                &other,
                &wrong_client,
                now
            )),
            InvalidGrantReason::CodeClientMismatch { .. }
        ));

        let code = issued_code(&store, "app", now);
        let wrong_redirect = CodeRedemption {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: &elsewhere,
        };
        assert!(matches!(
            reason(RedeemedAuthorizationCode::redeem(
                &store,
                &app,
                &wrong_redirect,
                now
            )),
            InvalidGrantReason::CodeRedirectMismatch { .. }
        ));

        let code = issued_code(
            &store,
            "app",
            now - AUTHORIZATION_CODE_TTL - Duration::seconds(1),
        );
        let expired = CodeRedemption {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: &redirect(),
        };
        assert!(matches!(
            reason(RedeemedAuthorizationCode::redeem(
                &store, &app, &expired, now
            )),
            InvalidGrantReason::CodeExpired { .. }
        ));

        let code = issued_code(&store, "app", now);
        let bad_verifier = CodeRedemption {
            code: &code,
            code_verifier: "not-the-verifier-not-the-verifier-not-the-verif",
            redirect_uri: &redirect(),
        };
        assert!(matches!(
            reason(RedeemedAuthorizationCode::redeem(
                &store,
                &app,
                &bad_verifier,
                now
            )),
            InvalidGrantReason::PkceMismatch { .. }
        ));
    }

    /// The device poll outcomes: a pending request is `authorization_pending`
    /// (and stamps the poll), a fast second poll is `slow_down`, an approved one
    /// is claimed exactly once with the granted scopes, and another client's
    /// request is unknown.
    #[test]
    fn a_device_request_reports_its_status_and_is_claimed_once() {
        let store = FakeGatekeeperStore::default();
        let now = Utc::now();
        let client = authenticated(&store, "client");
        let stranger = authenticated(&store, "stranger");
        store
            .insert_authorization_request(&device_request("dev", "CODE", RequestStatus::Pending))
            .unwrap();

        assert!(matches!(
            ConsumedDeviceRequest::consume(&store, &client, "dev", now),
            Err(TokenExchangeError::AuthorizationPending)
        ));
        assert!(matches!(
            ConsumedDeviceRequest::consume(&store, &client, "dev", now + Duration::seconds(1)),
            Err(TokenExchangeError::SlowDown)
        ));
        assert!(matches!(
            reason(ConsumedDeviceRequest::consume(
                &store, &stranger, "dev", now
            )),
            InvalidGrantReason::DeviceRequestNotFound { .. }
        ));

        store
            .approve_authorization_request("dev", &["openid".to_owned()], None, None)
            .unwrap();
        let later = now + DEVICE_CODE_POLL_INTERVAL;
        let proof = ConsumedDeviceRequest::consume(&store, &client, "dev", later).expect("claimed");
        assert_eq!(proof.client_id(), "client");
        assert_eq!(proof.granted_scopes(), ["openid"]);
        assert_eq!(proof.authorization_code(), None);
        assert!(matches!(
            ConsumedDeviceRequest::consume(&store, &client, "dev", later),
            Err(TokenExchangeError::ExpiredToken)
        ));
    }

    fn live_family(store: &FakeGatekeeperStore, client_id: &str, now: DateTime<Utc>) {
        store
            .insert_refresh_token_family_row(&RefreshTokenFamily {
                family_id: "fam".to_owned(),
                client_id: client_id.to_owned(),
                scopes: vec!["openid".to_owned(), "offline_access".to_owned()],
                patient: None,
                issued_at: now,
                expires_at: now + Duration::days(1),
                authorization_code_hash: None,
                grant_id: None,
            })
            .unwrap();
        store
            .insert_refresh_token(&RefreshToken {
                token_hash: token_storage_hash("live"),
                family_id: "fam".to_owned(),
                issued_at: now,
                consumed_at: None,
            })
            .unwrap();
    }

    /// A live token validates for its own client (carrying the family's scopes
    /// and hash) and is refused, with distinct reasons, when unknown, presented
    /// by another client, or past the family deadline.
    #[test]
    fn a_refresh_token_validates_for_its_client_while_the_family_lives() {
        let store = FakeGatekeeperStore::default();
        let now = Utc::now();
        let client = authenticated(&store, "client");
        let stranger = authenticated(&store, "stranger");
        live_family(&store, "client", now);

        let proof =
            ValidatedRefreshToken::validate(&store, &client, "live", now).expect("validates");
        assert_eq!(proof.family_id(), "fam");
        assert_eq!(proof.presented_hash(), token_storage_hash("live"));
        assert_eq!(proof.granted_scopes(), ["openid", "offline_access"]);
        assert_eq!(
            reason(ValidatedRefreshToken::validate(
                &store, &client, "ghost", now
            )),
            InvalidGrantReason::RefreshTokenNotFound
        );
        assert!(matches!(
            reason(ValidatedRefreshToken::validate(
                &store, &stranger, "live", now
            )),
            InvalidGrantReason::RefreshTokenClientMismatch { .. }
        ));
        assert_eq!(
            reason(ValidatedRefreshToken::validate(
                &store,
                &client,
                "live",
                now + Duration::days(2)
            )),
            InvalidGrantReason::RefreshTokenExpired
        );
    }
}
