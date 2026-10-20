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
//!  - [`ValidatedRefreshToken`] — a live refresh token bound to its client,
//!    validated before the refresh-family writer rotates it.
//!
//! [`GrantRedemption`] names the two that may also start a refresh-token
//! family (a refresh can only rotate the family it belongs to). Every proof
//! is minted under through its [`TokenEntitlement`] variant.
//!
//! Each constructor runs inside the token exchange's write scope, but for
//! [`ValidatedRefreshToken`], validated in a `read` scope first and
//! re-validated in the write scope (see its doc). A refusal
//! that follows a write (a code consumed and then found bound elsewhere, a
//! device poll stamped) is the inner `Err` of a nested result, so the scope
//! commits what it wrote rather than rolling it back.

use chrono::{DateTime, Utc};
use subtle::ConstantTimeEq;
use url::Url;
use wildflowerhealthio_scopes::KnownScope;

use super::authenticated_client::AuthenticatedClient;
#[cfg(doc)]
use super::token_entitlement::TokenEntitlement;
use crate::crypto_util::pkce::{compute_code_challenge, is_valid_code_verifier_length};
use crate::crypto_util::random_token::token_storage_hash;
use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_request::{
    device_grant_name, Approval, RequestStatus, DEVICE_CODE_POLL_INTERVAL,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::{
    write_transition, AuthorizationCodesTx, AuthorizationRequestsTx, BrowserSessionsTx, GrantsTx,
    RefreshTokensTx,
};
use crate::domain::refresh_token::RefreshTokenFamily;
use crate::domain::token_exchange_error::{InvalidGrantReason, TokenExchangeError};
use crate::ports::RevocationCheck;

/// The presented halves of an `authorization_code` grant request (RFC 6749
/// §4.1.3), as the client sent them.
pub(crate) struct PresentedAuthorizationCode<'a> {
    pub(crate) code: &'a str,
    pub(crate) code_verifier: &'a str,
    pub(crate) redirect_uri: &'a str,
}

/// A redemption that may start a refresh-token family: the two grants that
/// establish a session rather than renew one.
#[derive(Clone, Copy)]
pub(crate) enum GrantRedemption<'a> {
    /// An authorization code redeemed at `/oauth/token`.
    AuthorizationCode(&'a RedeemedAuthorizationCode),
    /// An approved device request claimed by its poll.
    DeviceCode(&'a ConsumedDeviceRequest),
}

impl<'a> GrantRedemption<'a> {
    /// The `client_id` the redemption is bound to.
    pub(crate) fn client_id(self) -> &'a str {
        match self {
            GrantRedemption::AuthorizationCode(redeemed_code) => redeemed_code.client_id(),
            GrantRedemption::DeviceCode(consumed_device_request) => {
                consumed_device_request.client_id()
            }
        }
    }

    /// SMART-on-FHIR patient context bound at approval, if any.
    pub(crate) fn patient(self) -> Option<&'a str> {
        match self {
            GrantRedemption::AuthorizationCode(redeemed_code) => redeemed_code.patient(),
            GrantRedemption::DeviceCode(consumed_device_request) => {
                consumed_device_request.patient()
            }
        }
    }

    /// The scopes as granted (before the minter's spelling twin), for the
    /// token response's `scope` and the family's record.
    pub(crate) fn granted_scopes(self) -> &'a [String] {
        match self {
            GrantRedemption::AuthorizationCode(redeemed_code) => redeemed_code.granted_scopes(),
            GrantRedemption::DeviceCode(consumed_device_request) => {
                consumed_device_request.granted_scopes()
            }
        }
    }

    /// The authorization code this redemption consumed, so a later replay of
    /// that code can revoke the family it started; `None` for the device flow.
    pub(crate) fn authorization_code(self) -> Option<&'a str> {
        match self {
            GrantRedemption::AuthorizationCode(redeemed_code) => {
                Some(redeemed_code.authorization_code())
            }
            GrantRedemption::DeviceCode(_) => None,
        }
    }

    /// The browser session the redemption was made under, which the family it
    /// starts records; `None` for the device flow.
    pub(crate) fn sid(self) -> Option<&'a str> {
        match self {
            GrantRedemption::AuthorizationCode(redeemed_code) => Some(redeemed_code.sid()),
            GrantRedemption::DeviceCode(_) => None,
        }
    }

    /// The standing grant behind this redemption, if one was resolved.
    pub(crate) fn grant_id(self) -> Option<&'a str> {
        match self {
            GrantRedemption::AuthorizationCode(redeemed_code) => redeemed_code.grant_id(),
            GrantRedemption::DeviceCode(consumed_device_request) => {
                consumed_device_request.grant_id()
            }
        }
    }

    /// Whether the grant carries [`KnownScope::OfflineAccess`] and so earns a
    /// refresh-token family alongside its access token.
    pub(crate) fn earns_refresh_token(self) -> bool {
        self.granted_scopes()
            .iter()
            .any(|scope| scope == KnownScope::OfflineAccess.as_str())
    }
}

/// An authorization code that has been atomically consumed and verified: bound
/// to the redeeming client and `redirect_uri`, unexpired, and matching the
/// PKCE verifier. Carries the code's granted scopes.
pub(crate) struct RedeemedAuthorizationCode {
    code: IssuedAuthorizationCode,
    token_scopes: Vec<String>,
    grant_id: Option<String>,
}

impl RedeemedAuthorizationCode {
    /// Check the presented request is well formed, then atomically
    /// read-and-consume the code and verify every binding. A malformed request
    /// is refused before the code is touched. A code that is gone (redeemed or
    /// never issued) is a possible replay: any refresh family minted from it is
    /// revoked before the refusal (RFC 6749 §4.1.2). The binding failures all
    /// collapse to `invalid_grant` on the wire (the reason is logged), so a
    /// response never reveals which check failed.
    ///
    /// The refusals, as the inner `Err`:
    /// [`TokenExchangeError::InvalidCodeVerifier`] (RFC 7636 §4.1 length) or
    /// [`TokenExchangeError::InvalidRedirectUri`] for a malformed request, and
    /// [`TokenExchangeError::InvalidGrant`] with the specific reason.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn redeem(
        tx: &mut (impl AuthorizationCodesTx + RefreshTokensTx + GrantsTx),
        authenticated_client: &AuthenticatedClient,
        presented: &PresentedAuthorizationCode<'_>,
        now: DateTime<Utc>,
    ) -> Result<Result<Self, TokenExchangeError>, AuthorizationServerError> {
        if !is_valid_code_verifier_length(presented.code_verifier) {
            return Ok(Err(TokenExchangeError::InvalidCodeVerifier));
        }
        let Ok(redirect_uri) = Url::parse(presented.redirect_uri) else {
            return Ok(Err(TokenExchangeError::InvalidRedirectUri));
        };
        // A concurrent redemption of the same code can only succeed once, so
        // any racer past this point sees `None` (RFC 6749 §10.5).
        let Some(code) = tx.redeem_authorization_code(presented.code)? else {
            tx.expire_refresh_token_families_for_authorization_code(
                &token_storage_hash(presented.code),
                now,
            )?;
            return Ok(Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::CodeNotFoundOrRedeemed,
            )));
        };
        if let Err(reason) =
            check_code_bindings(&code, authenticated_client, &redirect_uri, presented, now)
        {
            return Ok(Err(TokenExchangeError::InvalidGrant(reason)));
        }
        // The standing grant behind this exchange, recorded on the family
        // (write-only in v1); a grant revoked between approval and redemption
        // just leaves it `None`.
        let grant_id = tx
            .grant_by_client_and_redirect(authenticated_client.client_id(), &redirect_uri)?
            .map(|grant| grant.id);
        Ok(Ok(RedeemedAuthorizationCode {
            token_scopes: token_scope_spellings(&code.granted_scopes),
            code,
            grant_id,
        }))
    }

    /// The redeeming client.
    pub(crate) fn client_id(&self) -> &str {
        &self.code.client_id
    }

    /// The code's scopes with each SMART scope's alternate spelling added —
    /// the token's `scope` claim.
    pub(crate) fn token_scopes(&self) -> &[String] {
        &self.token_scopes
    }

    /// The scopes the code was issued with.
    pub(crate) fn granted_scopes(&self) -> &[String] {
        &self.code.granted_scopes
    }

    /// The patient context the code was bound to, if any.
    pub(crate) fn patient(&self) -> Option<&str> {
        self.code.patient.as_deref()
    }

    /// The consumed code itself.
    pub(crate) fn authorization_code(&self) -> &str {
        &self.code.code
    }

    /// The browser session the code was issued under.
    pub(crate) fn sid(&self) -> &str {
        &self.code.sid
    }

    /// The standing grant behind the code, if one was resolved.
    pub(crate) fn grant_id(&self) -> Option<&str> {
        self.grant_id.as_deref()
    }
}

/// An approved device request that this poll has atomically claimed (RFC 8628
/// §3.4 single use), bound to the polling client. Carries the scopes the Owner
/// granted at approval.
pub(crate) struct ConsumedDeviceRequest {
    client_id: String,
    approval: Approval,
    token_scopes: Vec<String>,
    grant_id: Option<String>,
}

impl ConsumedDeviceRequest {
    /// Resolve the device request for `device_code`, require it to be this
    /// client's, unexpired, and approved (stamping the poll and throttling a
    /// still-pending one per §3.5), then claim it, single use, under the
    /// scope's write lock, so two concurrent polls can't both mint.
    ///
    /// The refusals, as the inner `Err`: the §3.5 poll outcomes
    /// ([`ExpiredToken`](TokenExchangeError::ExpiredToken),
    /// [`AuthorizationPending`](TokenExchangeError::AuthorizationPending),
    /// [`AccessDenied`](TokenExchangeError::AccessDenied),
    /// [`SlowDown`](TokenExchangeError::SlowDown)), with an already-claimed
    /// request answering `ExpiredToken`;
    /// [`TokenExchangeError::InvalidGrant`] for an unknown request, or one
    /// whose guarded claim loses a race to a concurrent poll.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn consume(
        tx: &mut (impl AuthorizationRequestsTx + GrantsTx),
        authenticated_client: &AuthenticatedClient,
        device_code: &str,
        now: DateTime<Utc>,
    ) -> Result<Result<Self, TokenExchangeError>, AuthorizationServerError> {
        // One outcome collapses "no such device_code", "wrong client", and
        // "not a device request".
        let Some((request, device_request)) = tx
            .authorization_request_by_id(device_code)?
            .filter(|request| request.client_id() == authenticated_client.client_id())
            .and_then(|request| {
                let device_request = request.device()?.clone();
                Some((request, device_request))
            })
        else {
            return Ok(Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::DeviceRequestNotFound {
                    presented_client_id: authenticated_client.client_id().to_owned(),
                },
            )));
        };
        if request.is_expired_at(now) {
            return Ok(Err(TokenExchangeError::ExpiredToken));
        }
        let approval = match request.status() {
            RequestStatus::Pending => {
                if device_request
                    .last_polled_at
                    .is_some_and(|last_polled| now - last_polled < DEVICE_CODE_POLL_INTERVAL)
                {
                    return Ok(Err(TokenExchangeError::SlowDown));
                }
                write_transition(tx, request.stamp_device_poll(now))?;
                return Ok(Err(TokenExchangeError::AuthorizationPending));
            }
            RequestStatus::Denied => return Ok(Err(TokenExchangeError::AccessDenied)),
            // A claimed request already minted its token: as RFC 8628 §3.5
            // has it, the device code has expired.
            RequestStatus::Claimed => return Ok(Err(TokenExchangeError::ExpiredToken)),
            RequestStatus::Approved => request.approval().cloned().ok_or_else(|| {
                AuthorizationServerError::infrastructure(
                    "claiming a device request",
                    "an approved request carries no approval",
                )
            })?,
        };
        if !write_transition(tx, request.claim(now))? {
            return Ok(Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::DeviceCodeAlreadyRedeemed {
                    client_id: request.client_id().to_owned(),
                },
            )));
        }
        let grant_name = device_grant_name(
            device_request.device_name.as_deref(),
            authenticated_client.name(),
        );
        let grant_id = tx
            .device_grant_by_client_and_device_name(request.client_id(), grant_name)?
            .map(|grant| grant.id);
        Ok(Ok(ConsumedDeviceRequest {
            token_scopes: token_scope_spellings(&approval.granted_scopes),
            client_id: request.client_id().to_owned(),
            approval,
            grant_id,
        }))
    }

    /// The polling client the request was claimed by.
    pub(crate) fn client_id(&self) -> &str {
        &self.client_id
    }

    /// The granted scopes with each SMART scope's alternate spelling added —
    /// the token's `scope` claim.
    pub(crate) fn token_scopes(&self) -> &[String] {
        &self.token_scopes
    }

    /// The scopes the Owner granted at approval.
    pub(crate) fn granted_scopes(&self) -> &[String] {
        &self.approval.granted_scopes
    }

    /// The patient context bound at approval, if any.
    pub(crate) fn patient(&self) -> Option<&str> {
        self.approval.patient.as_deref()
    }

    /// The standing device grant behind the request, if one was resolved.
    pub(crate) fn grant_id(&self) -> Option<&str> {
        self.grant_id.as_deref()
    }
}

/// A refresh token that resolved to a live family owned by the presenting
/// client (RFC 6749 §6). Not yet consumed: the refresh-family writer rotates
/// it.
///
/// Built in two scopes. [`validate`](Self::validate) runs the whole
/// validation in a `read` scope, the client's revocation epoch included: the
/// epoch lives on the revocation store, another connection to the same file,
/// so it can't be read under the exchange's write lock without risking a
/// lock-order stall. [`revalidate`](Self::revalidate) then re-runs the
/// store-only half inside the `write` scope that rotates, because the family
/// may have ended between the two.
pub(crate) struct ValidatedRefreshToken {
    family: RefreshTokenFamily,
    presented_hash: String,
    token_scopes: Vec<String>,
}

impl ValidatedRefreshToken {
    /// Resolve the presented token's family and require it to be this client's,
    /// unexpired, not minted under a revoked browser session, and begun no
    /// earlier than its client's revocation epoch. A valid token presented by
    /// the wrong client is answered exactly like an unknown one so a stranger
    /// can't probe validity, and is refused before any consume so it can't
    /// burn the rightful client's token. Runs in a `read` scope, outside the
    /// write lock (see the type's doc).
    ///
    /// # Errors
    ///
    /// [`TokenExchangeError::InvalidGrant`] with the specific reason;
    /// [`TokenExchangeError::Store`] on a store failure, the revocation
    /// store's included, so an unreadable epoch never admits a family.
    pub(crate) fn validate(
        tx: &mut (impl RefreshTokensTx + BrowserSessionsTx),
        revocation: &dyn RevocationCheck,
        authenticated_client: &AuthenticatedClient,
        presented_refresh_token: &str,
        now: DateTime<Utc>,
    ) -> Result<Self, TokenExchangeError> {
        let validated = Self::live_family(
            tx,
            authenticated_client,
            token_storage_hash(presented_refresh_token),
            now,
        )?;
        // Bumping a client's revocation epoch revokes every token it held at
        // that instant, refresh families included: a family begun before the
        // epoch is refused like an access token issued before it. The family
        // has no `jti` of its own, so only the epoch applies.
        let family_predates_client_epoch = revocation
            .is_revoked(
                None,
                Some(validated.family.issued_at),
                &validated.family.client_id,
            )
            .map_err(|error| {
                AuthorizationServerError::infrastructure(
                    "refresh-token revocation epoch check failed",
                    error,
                )
            })?;
        if family_predates_client_epoch {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenClientRevoked {
                    family_id: validated.family.family_id,
                },
            ));
        }
        Ok(validated)
    }

    /// Re-load this token's family inside the rotating `write` scope `tx` and
    /// re-check the store-only facts — this client's, unexpired, its browser
    /// session not revoked — since the family may have ended after
    /// [`validate`](Self::validate)'s scope closed. The epoch was checked
    /// there and is not re-read here (see the type's doc).
    ///
    /// # Errors
    ///
    /// As [`validate`](Self::validate), less the epoch check.
    pub(crate) fn revalidate(
        self,
        tx: &mut (impl RefreshTokensTx + BrowserSessionsTx),
        authenticated_client: &AuthenticatedClient,
        now: DateTime<Utc>,
    ) -> Result<Self, TokenExchangeError> {
        Self::live_family(tx, authenticated_client, self.presented_hash, now)
    }

    /// The store-only half of validation: the family `presented_hash`
    /// belongs to, required to be `authenticated_client`'s, unexpired at
    /// `now`, and not minted under a revoked browser session.
    fn live_family(
        tx: &mut (impl RefreshTokensTx + BrowserSessionsTx),
        authenticated_client: &AuthenticatedClient,
        presented_hash: String,
        now: DateTime<Utc>,
    ) -> Result<Self, TokenExchangeError> {
        let Some((_, family)) = tx.refresh_token_with_family_by_hash(&presented_hash)? else {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenNotFound,
            ));
        };
        if family.client_id != authenticated_client.client_id() {
            return Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenClientMismatch {
                    family_client_id: family.client_id,
                    presented_client_id: authenticated_client.client_id().to_owned(),
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
        // Revoking a browser session ends every family minted under it. A
        // family with no session (the device flow) has none to check.
        if let Some(sid) = family.sid.as_deref() {
            if tx.browser_session_is_revoked(sid)? {
                return Err(TokenExchangeError::InvalidGrant(
                    InvalidGrantReason::RefreshTokenSessionRevoked {
                        family_id: family.family_id,
                    },
                ));
            }
        }
        Ok(ValidatedRefreshToken {
            token_scopes: token_scope_spellings(&family.scopes),
            family,
            presented_hash,
        })
    }

    /// The client the family belongs to.
    pub(crate) fn client_id(&self) -> &str {
        &self.family.client_id
    }

    /// The family's scopes with each SMART scope's alternate spelling added —
    /// the token's `scope` claim.
    pub(crate) fn token_scopes(&self) -> &[String] {
        &self.token_scopes
    }

    /// The family's scopes as granted, for the token response's `scope`.
    pub(crate) fn granted_scopes(&self) -> &[String] {
        &self.family.scopes
    }

    /// The patient context the family was bound to, if any.
    pub(crate) fn patient(&self) -> Option<&str> {
        self.family.patient.as_deref()
    }

    /// The browser session the family was minted under, if any.
    pub(crate) fn sid(&self) -> Option<&str> {
        self.family.sid.as_deref()
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

/// Why the consumed `code` may not be redeemed by `authenticated_client`
/// with `redirect_uri` and the presented verifier at `now`, if anything: it
/// must be the client's, for that redirect, unexpired, and its PKCE challenge
/// must match the verifier.
fn check_code_bindings(
    code: &IssuedAuthorizationCode,
    authenticated_client: &AuthenticatedClient,
    redirect_uri: &Url,
    presented: &PresentedAuthorizationCode<'_>,
    now: DateTime<Utc>,
) -> Result<(), InvalidGrantReason> {
    if code.client_id != authenticated_client.client_id() {
        return Err(InvalidGrantReason::CodeClientMismatch {
            code_client_id: code.client_id.clone(),
            presented_client_id: authenticated_client.client_id().to_owned(),
        });
    }
    if code.redirect_uri != *redirect_uri {
        return Err(InvalidGrantReason::CodeRedirectMismatch {
            code_redirect_uri: code.redirect_uri.to_string(),
            presented_redirect_uri: redirect_uri.to_string(),
        });
    }
    if code.expires_at < now {
        return Err(InvalidGrantReason::CodeExpired {
            expires_at: code.expires_at,
        });
    }
    let computed = compute_code_challenge(presented.code_verifier);
    if !bool::from(code.code_challenge.as_bytes().ct_eq(computed.as_bytes())) {
        return Err(InvalidGrantReason::PkceMismatch {
            client_id: authenticated_client.client_id().to_owned(),
        });
    }
    Ok(())
}

/// The scopes a token carries: each granted scope alongside its alternate
/// canonical form, so a v1-worded grant also carries its v2 letter spelling
/// (see [`wildflowerhealthio_scopes::with_alternate_canonical_forms`]). The response's
/// `scope` stays the granted set as-is.
fn token_scope_spellings(granted: &[String]) -> Vec<String> {
    wildflowerhealthio_scopes::with_alternate_canonical_forms(granted)
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use super::*;
    use crate::crypto_util::random_token::generate_authorization_code;
    use crate::domain::authorization_code::AUTHORIZATION_CODE_TTL;
    use crate::domain::browser_session::BrowserSession;

    use crate::domain::refresh_token::RefreshToken;
    use crate::domain::test_fake::{
        approve_stored, authenticated_public_client, client, device_request, FakeGrantStore,
        NothingRevoked,
    };
    use wildflowerhealthio_token_revocation::RevocationStore;

    fn authenticated(store: &FakeGrantStore, client_id: &str) -> AuthenticatedClient {
        authenticated_public_client(store, client(client_id, &["openid"]))
    }

    const REDIRECT: &str = "https://example.com/cb";

    fn redirect() -> Url {
        Url::parse(REDIRECT).unwrap()
    }

    const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-1";

    fn issued_code(store: &FakeGrantStore, client_id: &str, now: DateTime<Utc>) -> String {
        let code = generate_authorization_code();
        store
            .tx()
            .issue_authorization_code(&IssuedAuthorizationCode {
                code: code.clone(),
                request_id: "req".to_owned(),
                client_id: client_id.to_owned(),
                redirect_uri: redirect(),
                code_challenge: compute_code_challenge(VERIFIER),
                granted_scopes: vec!["patient/Patient.read".to_owned()],
                patient: Some("pat-1".to_owned()),
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
                sid: "sid-1".to_owned(),
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
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let client = authenticated(&store, "app");
        let code = issued_code(&store, "app", now);
        let redemption = PresentedAuthorizationCode {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: REDIRECT,
        };
        let proof = RedeemedAuthorizationCode::redeem(&mut store.tx(), &client, &redemption, now)
            .unwrap()
            .expect("redeems");
        assert_eq!(proof.client_id(), "app");
        assert_eq!(proof.patient(), Some("pat-1"));
        assert_eq!(proof.granted_scopes(), ["patient/Patient.read"]);
        assert_eq!(
            proof.token_scopes(),
            ["patient/Patient.read", "patient/Patient.rs"]
        );
        assert_eq!(proof.authorization_code(), code);
        assert_eq!(
            GrantRedemption::AuthorizationCode(&proof).authorization_code(),
            Some(code.as_str())
        );
        assert_eq!(
            reason(
                RedeemedAuthorizationCode::redeem(&mut store.tx(), &client, &redemption, now)
                    .unwrap()
            ),
            InvalidGrantReason::CodeNotFoundOrRedeemed
        );
    }

    /// Each binding refuses with its own reason: wrong client, wrong redirect,
    /// expired, bad verifier, each on a freshly issued code.
    #[test]
    fn a_code_is_refused_for_each_broken_binding() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let app = authenticated(&store, "app");
        let other = authenticated(&store, "other");

        let code = issued_code(&store, "app", now);
        let wrong_client = PresentedAuthorizationCode {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: REDIRECT,
        };
        assert!(matches!(
            reason(
                RedeemedAuthorizationCode::redeem(&mut store.tx(), &other, &wrong_client, now)
                    .unwrap()
            ),
            InvalidGrantReason::CodeClientMismatch { .. }
        ));

        let code = issued_code(&store, "app", now);
        let wrong_redirect = PresentedAuthorizationCode {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: "https://elsewhere.example/cb",
        };
        assert!(matches!(
            reason(
                RedeemedAuthorizationCode::redeem(&mut store.tx(), &app, &wrong_redirect, now)
                    .unwrap()
            ),
            InvalidGrantReason::CodeRedirectMismatch { .. }
        ));

        let code = issued_code(
            &store,
            "app",
            now - AUTHORIZATION_CODE_TTL - Duration::seconds(1),
        );
        let expired = PresentedAuthorizationCode {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: REDIRECT,
        };
        assert!(matches!(
            reason(
                RedeemedAuthorizationCode::redeem(&mut store.tx(), &app, &expired, now).unwrap()
            ),
            InvalidGrantReason::CodeExpired { .. }
        ));

        let code = issued_code(&store, "app", now);
        let bad_verifier = PresentedAuthorizationCode {
            code: &code,
            code_verifier: "not-the-verifier-not-the-verifier-not-the-verif",
            redirect_uri: REDIRECT,
        };
        assert!(matches!(
            reason(
                RedeemedAuthorizationCode::redeem(&mut store.tx(), &app, &bad_verifier, now)
                    .unwrap()
            ),
            InvalidGrantReason::PkceMismatch { .. }
        ));
    }

    /// The device poll outcomes: a pending request is `authorization_pending`
    /// (and stamps the poll), a fast second poll is `slow_down`, an approved one
    /// is claimed exactly once with the granted scopes, and another client's
    /// request is unknown.
    #[test]
    fn a_device_request_reports_its_status_and_is_claimed_once() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let client = authenticated(&store, "client");
        let stranger = authenticated(&store, "stranger");
        store
            .tx()
            .insert_authorization_request(&device_request("dev", "CODE", RequestStatus::Pending))
            .unwrap();

        assert!(matches!(
            ConsumedDeviceRequest::consume(&mut store.tx(), &client, "dev", now).unwrap(),
            Err(TokenExchangeError::AuthorizationPending)
        ));
        assert!(matches!(
            ConsumedDeviceRequest::consume(
                &mut store.tx(),
                &client,
                "dev",
                now + Duration::seconds(1)
            )
            .unwrap(),
            Err(TokenExchangeError::SlowDown)
        ));
        assert!(matches!(
            reason(ConsumedDeviceRequest::consume(&mut store.tx(), &stranger, "dev", now).unwrap()),
            InvalidGrantReason::DeviceRequestNotFound { .. }
        ));

        approve_stored(&store, "dev", &["openid"], None);
        let later = now + DEVICE_CODE_POLL_INTERVAL;
        let proof = ConsumedDeviceRequest::consume(&mut store.tx(), &client, "dev", later)
            .unwrap()
            .expect("claimed");
        assert_eq!(proof.client_id(), "client");
        assert_eq!(proof.granted_scopes(), ["openid"]);
        assert_eq!(
            GrantRedemption::DeviceCode(&proof).authorization_code(),
            None
        );
        assert!(matches!(
            ConsumedDeviceRequest::consume(&mut store.tx(), &client, "dev", later).unwrap(),
            Err(TokenExchangeError::ExpiredToken)
        ));
    }

    fn live_family(store: &FakeGrantStore, client_id: &str, now: DateTime<Utc>) {
        live_family_under(store, client_id, None, now);
    }

    fn live_family_under(
        store: &FakeGrantStore,
        client_id: &str,
        sid: Option<&str>,
        now: DateTime<Utc>,
    ) {
        store
            .tx()
            .insert_refresh_token_family_row(&RefreshTokenFamily {
                family_id: "fam".to_owned(),
                client_id: client_id.to_owned(),
                scopes: vec!["openid".to_owned(), "offline_access".to_owned()],
                patient: None,
                issued_at: now,
                expires_at: now + Duration::days(1),
                authorization_code_hash: None,
                grant_id: None,
                sid: sid.map(str::to_owned),
            })
            .unwrap();
        store
            .tx()
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
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let client = authenticated(&store, "client");
        let stranger = authenticated(&store, "stranger");
        live_family(&store, "client", now);

        let proof =
            ValidatedRefreshToken::validate(&mut store.tx(), &NothingRevoked, &client, "live", now)
                .expect("validates");
        assert_eq!(proof.family_id(), "fam");
        assert_eq!(proof.presented_hash(), token_storage_hash("live"));
        assert_eq!(proof.granted_scopes(), ["openid", "offline_access"]);
        assert_eq!(
            reason(ValidatedRefreshToken::validate(
                &mut store.tx(),
                &NothingRevoked,
                &client,
                "ghost",
                now
            )),
            InvalidGrantReason::RefreshTokenNotFound
        );
        assert!(matches!(
            reason(ValidatedRefreshToken::validate(
                &mut store.tx(),
                &NothingRevoked,
                &stranger,
                "live",
                now
            )),
            InvalidGrantReason::RefreshTokenClientMismatch { .. }
        ));
        assert_eq!(
            reason(ValidatedRefreshToken::validate(
                &mut store.tx(),
                &NothingRevoked,
                &client,
                "live",
                now + Duration::days(2)
            )),
            InvalidGrantReason::RefreshTokenExpired
        );
    }

    /// A family minted under a browser session validates while the session
    /// stands and carries its `sid`; once the session is revoked, or when the
    /// `sid` names no session, the family is refused. A family with no
    /// session (the device flow) has none to check, which the test above
    /// covers.
    #[test]
    fn a_refresh_token_is_refused_once_its_session_is_revoked() {
        let now = Utc::now();
        let session = BrowserSession::new_owner(vec![], Duration::hours(8), now);

        let store = FakeGrantStore::default();
        let client = authenticated(&store, "client");
        store.tx().insert_browser_session(&session).unwrap();
        live_family_under(&store, "client", Some(&session.sid), now);
        let proof =
            ValidatedRefreshToken::validate(&mut store.tx(), &NothingRevoked, &client, "live", now)
                .expect("validates");
        assert_eq!(proof.sid(), Some(session.sid.as_str()));
        assert!(store
            .tx()
            .revoke_browser_session(&session.sid, now)
            .unwrap());
        assert_eq!(
            reason(ValidatedRefreshToken::validate(
                &mut store.tx(),
                &NothingRevoked,
                &client,
                "live",
                now
            )),
            InvalidGrantReason::RefreshTokenSessionRevoked {
                family_id: "fam".to_owned()
            }
        );

        let store = FakeGrantStore::default();
        let client = authenticated(&store, "client");
        live_family_under(&store, "client", Some("no-such-sid"), now);
        assert_eq!(
            reason(ValidatedRefreshToken::validate(
                &mut store.tx(),
                &NothingRevoked,
                &client,
                "live",
                now
            )),
            InvalidGrantReason::RefreshTokenSessionRevoked {
                family_id: "fam".to_owned()
            }
        );
    }

    /// A family begun before its client's revocation epoch is refused; one
    /// begun at or after it, or belonging to another client, still validates.
    #[test]
    fn a_refresh_token_is_refused_once_its_client_epoch_passes_the_family() {
        let now = Utc::now();
        let store = FakeGrantStore::default();
        let client = authenticated(&store, "client");
        live_family(&store, "client", now);
        let revocation_store = RevocationStore::open_in_memory().expect("revocation store");

        revocation_store
            .bump_subject_epoch("client", now)
            .expect("bump to the family's start");
        ValidatedRefreshToken::validate(&mut store.tx(), &revocation_store, &client, "live", now)
            .expect("a family begun at the epoch validates");
        revocation_store
            .bump_subject_epoch("other-client", now + Duration::seconds(1))
            .expect("bump another client");
        ValidatedRefreshToken::validate(&mut store.tx(), &revocation_store, &client, "live", now)
            .expect("another client's epoch doesn't touch this family");

        revocation_store
            .bump_subject_epoch("client", now + Duration::seconds(1))
            .expect("bump past the family's start");
        assert_eq!(
            reason(ValidatedRefreshToken::validate(
                &mut store.tx(),
                &revocation_store,
                &client,
                "live",
                now
            )),
            InvalidGrantReason::RefreshTokenClientRevoked {
                family_id: "fam".to_owned()
            }
        );
    }
}
