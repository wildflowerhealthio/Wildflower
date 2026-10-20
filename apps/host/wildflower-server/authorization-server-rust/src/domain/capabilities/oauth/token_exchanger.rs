//! [`TokenExchanger`] — the `/oauth/token` flows (RFC 6749 §4.1.3, RFC 8628
//! §3.4, RFC 6749 §6). Each runs in one write scope (a refresh is first
//! validated in a `read` scope; see
//! [`exchange_refresh_token`](TokenExchanger::exchange_refresh_token)): check the client may use
//! the grant type, obtain the redemption proof, load the signing key, and (for
//! the two session-establishing grants) start a refresh family, or (for a
//! refresh) rotate, then sign the token. Signing runs inside the scope, so a
//! signing failure rolls it back: the code stays unspent, the device request
//! unclaimed, the refresh token un-rotated. The proof is the hand-off between
//! the validation half and the writers, so a token is never minted for a grant
//! that didn't redeem.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::authority::{
    AuthenticatedClient, ConsumedDeviceRequest, GrantRedemption, PresentedAuthorizationCode,
    RedeemedAuthorizationCode, TokenEntitlement, ValidatedRefreshToken,
};
use crate::domain::capabilities::writers::{AccessTokenMinter, RefreshFamilyWriter};
use crate::domain::client::AllowedGrantType;
use crate::domain::token::ACCESS_TOKEN_TTL;
use crate::domain::token_exchange_error::TokenExchangeError;
use crate::domain::{GrantStore, GrantTx};
use crate::ports::RevocationCheck;

/// The tokens a successful exchange issued: what the RFC 6749 §5.1 token
/// response carries.
pub(crate) struct IssuedTokens {
    pub(crate) access_token: String,
    /// Seconds until the access token expires.
    pub(crate) expires_in: i64,
    /// The scopes as granted (not the twinned spellings the JWT carries).
    pub(crate) granted_scopes: Vec<String>,
    pub(crate) refresh_token: Option<String>,
    pub(crate) patient: Option<String>,
}

/// A write scope's answer: the issued tokens, or the refusal (the inner
/// `Err`) whose writes the scope keeps. The outer `Err` rolls the scope back.
type ExchangeOutcome = Result<Result<IssuedTokens, TokenExchangeError>, TokenExchangeError>;

/// Exchange grants for tokens on behalf of an [`AuthenticatedClient`]. Generic
/// over the store port so it's unit-testable against the fake; the binding
/// instantiates it over the concrete `SqliteGrantStore`.
pub(crate) struct TokenExchanger<S: GrantStore> {
    store: S,
    /// The revocation check a refresh runs against its client's epoch.
    revocation: Arc<dyn RevocationCheck>,
    /// The server's bare origin, every minted token's `iss` and `aud`.
    server_origin: Arc<str>,
}

impl<S: GrantStore> TokenExchanger<S> {
    /// Build the exchanger over a store handle, the revocation-check port and
    /// the server's origin, all lifted from the state.
    pub(crate) fn new(
        store: S,
        revocation: Arc<dyn RevocationCheck>,
        server_origin: Arc<str>,
    ) -> Self {
        TokenExchanger {
            store,
            revocation,
            server_origin,
        }
    }

    /// Redeem an authorization code with its PKCE verifier (RFC 6749 §4.1.3,
    /// RFC 7636 §4.6) and mint the token the code's consent authorized.
    ///
    /// # Errors
    ///
    /// [`TokenExchangeError::UnauthorizedGrantType`], the redemption's refusals
    /// (see [`RedeemedAuthorizationCode::redeem`]), or a minting / store
    /// failure.
    pub(crate) fn exchange_authorization_code(
        &self,
        authenticated_client: &AuthenticatedClient,
        presented: &PresentedAuthorizationCode<'_>,
        now: DateTime<Utc>,
    ) -> Result<IssuedTokens, TokenExchangeError> {
        ensure_grant_type_allowed(authenticated_client, AllowedGrantType::AuthorizationCode)?;
        self.store
            .write(|tx| self.redeem_code_in(tx, authenticated_client, presented, now))?
    }

    /// Poll a device request (RFC 8628 §3.4) and, once it is approved and this
    /// poll has claimed it, mint the token the Owner's approval authorized.
    ///
    /// # Errors
    ///
    /// [`TokenExchangeError::UnauthorizedGrantType`], the §3.5 poll outcomes,
    /// the claim's [`InvalidGrant`](TokenExchangeError::InvalidGrant), or a
    /// minting / store failure.
    pub(crate) fn exchange_device_code(
        &self,
        authenticated_client: &AuthenticatedClient,
        device_code: &str,
        now: DateTime<Utc>,
    ) -> Result<IssuedTokens, TokenExchangeError> {
        ensure_grant_type_allowed(authenticated_client, AllowedGrantType::DeviceCode)?;
        self.store
            .write(|tx| self.claim_device_request_in(tx, authenticated_client, device_code, now))?
    }

    /// Trade a live refresh token for a fresh access token and the refresh
    /// token's successor (RFC 6749 §6, OAuth 2.1 rotation). The family keeps
    /// its scopes and absolute deadline — rotation never extends its life.
    ///
    /// The one exchange with two scopes. A `read` scope validates the token,
    /// its client's revocation epoch included: the epoch lives on the
    /// revocation store, another connection to the same file, so reading it
    /// under our write lock could stall both connections for the busy
    /// timeout. The `write` scope then re-validates the store-only facts,
    /// since the family may have ended between the two, rotates, and mints.
    ///
    /// # Errors
    ///
    /// [`TokenExchangeError::UnauthorizedGrantType`], the validation's
    /// [`InvalidGrant`](TokenExchangeError::InvalidGrant), a replay
    /// ([`RefreshTokenReplayed`](crate::domain::token_exchange_error::InvalidGrantReason::RefreshTokenReplayed),
    /// after which the family is revoked), or a minting / store failure.
    pub(crate) fn exchange_refresh_token(
        &self,
        authenticated_client: &AuthenticatedClient,
        presented_refresh_token: &str,
        now: DateTime<Utc>,
    ) -> Result<IssuedTokens, TokenExchangeError> {
        ensure_grant_type_allowed(authenticated_client, AllowedGrantType::RefreshToken)?;
        let validated_refresh_token = self.store.read(|tx| {
            ValidatedRefreshToken::validate(
                tx,
                self.revocation.as_ref(),
                authenticated_client,
                presented_refresh_token,
                now,
            )
        })?;
        self.store.write(|tx| {
            self.rotate_refresh_token_in(tx, authenticated_client, validated_refresh_token, now)
        })?
    }

    /// [`exchange_authorization_code`](Self::exchange_authorization_code)'s
    /// flow, inside its write scope `tx`. A refusal is the inner `Err`, so the
    /// scope keeps the spent code (and any family a replay ended).
    fn redeem_code_in(
        &self,
        tx: &mut impl GrantTx,
        authenticated_client: &AuthenticatedClient,
        presented: &PresentedAuthorizationCode<'_>,
        now: DateTime<Utc>,
    ) -> ExchangeOutcome {
        let redeemed_code =
            match RedeemedAuthorizationCode::redeem(tx, authenticated_client, presented, now)? {
                Ok(redeemed_code) => redeemed_code,
                Err(refusal) => return Ok(Err(refusal)),
            };
        let redemption = GrantRedemption::AuthorizationCode(&redeemed_code);
        let (minter, refresh_token) = self.prepare_issuance(tx, redemption, now)?;
        issue(
            &minter,
            TokenEntitlement::AuthorizationCode(&redeemed_code),
            redemption.granted_scopes(),
            redeemed_code.patient(),
            refresh_token,
        )
    }

    /// [`exchange_device_code`](Self::exchange_device_code)'s flow, inside its
    /// write scope `tx`. A refusal is the inner `Err`, so the scope keeps the
    /// poll it stamped.
    fn claim_device_request_in(
        &self,
        tx: &mut impl GrantTx,
        authenticated_client: &AuthenticatedClient,
        device_code: &str,
        now: DateTime<Utc>,
    ) -> ExchangeOutcome {
        let consumed_device_request =
            match ConsumedDeviceRequest::consume(tx, authenticated_client, device_code, now)? {
                Ok(consumed_device_request) => consumed_device_request,
                Err(refusal) => return Ok(Err(refusal)),
            };
        let (minter, refresh_token) = self.prepare_issuance(
            tx,
            GrantRedemption::DeviceCode(&consumed_device_request),
            now,
        )?;
        issue(
            &minter,
            TokenEntitlement::DeviceCode(&consumed_device_request),
            consumed_device_request.granted_scopes(),
            consumed_device_request.patient(),
            refresh_token,
        )
    }

    /// [`exchange_refresh_token`](Self::exchange_refresh_token)'s write half,
    /// inside its write scope `tx`: re-validate the token validated in the
    /// read scope, rotate it, and mint. A refusal is the inner `Err`, so the
    /// scope keeps a replayed family's end.
    fn rotate_refresh_token_in(
        &self,
        tx: &mut impl GrantTx,
        authenticated_client: &AuthenticatedClient,
        validated_refresh_token: ValidatedRefreshToken,
        now: DateTime<Utc>,
    ) -> ExchangeOutcome {
        let validated_refresh_token =
            match validated_refresh_token.revalidate(tx, authenticated_client, now) {
                Ok(validated_refresh_token) => validated_refresh_token,
                Err(TokenExchangeError::Store(error)) => return Err(error.into()),
                Err(refusal) => return Ok(Err(refusal)),
            };
        let minter = AccessTokenMinter::with_active_key(tx, &self.server_origin, ACCESS_TOKEN_TTL)?;
        let successor =
            match RefreshFamilyWriter::within(tx).rotate(&validated_refresh_token, now)? {
                Ok(successor) => successor,
                Err(refusal) => return Ok(Err(refusal)),
            };
        issue(
            &minter,
            TokenEntitlement::RefreshToken(&validated_refresh_token),
            validated_refresh_token.granted_scopes(),
            validated_refresh_token.patient(),
            Some(successor),
        )
    }

    /// Load the signing key, then start `redemption`'s refresh family if the
    /// grant earned one, inside the exchange's scope `tx`.
    fn prepare_issuance(
        &self,
        tx: &mut impl GrantTx,
        redemption: GrantRedemption<'_>,
        now: DateTime<Utc>,
    ) -> Result<(AccessTokenMinter<'_>, Option<String>), TokenExchangeError> {
        let minter = AccessTokenMinter::with_active_key(tx, &self.server_origin, ACCESS_TOKEN_TTL)?;
        let refresh_token = if redemption.is_refresh_token_earned() {
            Some(RefreshFamilyWriter::within(tx).start_family(redemption, now)?)
        } else {
            None
        };
        Ok((minter, refresh_token))
    }
}

/// The registration must list the grant type the client is using.
fn ensure_grant_type_allowed(
    authenticated_client: &AuthenticatedClient,
    grant_type: AllowedGrantType,
) -> Result<(), TokenExchangeError> {
    if authenticated_client.allows_grant_type(grant_type) {
        Ok(())
    } else {
        Err(TokenExchangeError::UnauthorizedGrantType)
    }
}

/// Sign the access token under `entitlement` (its `iss` and `aud` are both
/// the server's origin; see `docs/Origins/Explanation.md`), and answer with
/// it, the exchange's `refresh_token`, and the `granted_scopes` and `patient`
/// the response reports. A signing failure is the outer `Err`, rolling the
/// exchange's scope back.
fn issue(
    minter: &AccessTokenMinter<'_>,
    entitlement: TokenEntitlement<'_>,
    granted_scopes: &[String],
    patient: Option<&str>,
    refresh_token: Option<String>,
) -> ExchangeOutcome {
    Ok(Ok(IssuedTokens {
        access_token: minter.mint(entitlement)?,
        expires_in: ACCESS_TOKEN_TTL.num_seconds(),
        granted_scopes: granted_scopes.to_vec(),
        refresh_token,
        patient: patient.map(str::to_owned),
    }))
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use crate::domain::token_exchange_error::InvalidGrantReason;

    use super::*;
    use crate::crypto_util::pkce::compute_code_challenge;
    use crate::crypto_util::random_token::generate_authorization_code;
    use crate::domain::authorization_code::{AuthorizationCode, AUTHORIZATION_CODE_TTL};
    use crate::domain::client::Client;
    use crate::domain::token::{verify_jwt, VerifyOptions};

    use crate::domain::test_fake::{
        authenticated_public_client, client, seed_active_signing_key, seed_fixture_browser_session,
        FakeGrantStore, NothingRevoked, FIXTURE_SID,
    };

    const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-1";
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";

    fn exchanger() -> TokenExchanger<FakeGrantStore> {
        let store = FakeGrantStore::default();
        seed_active_signing_key(&store);
        TokenExchanger::new(store, Arc::new(NothingRevoked), SERVER_ORIGIN.into())
    }

    fn authenticated(
        store: &FakeGrantStore,
        client_id: &str,
        grant_types: &[AllowedGrantType],
    ) -> AuthenticatedClient {
        authenticated_public_client(
            store,
            Client {
                allowed_grant_types: grant_types.to_vec(),
                ..client(client_id, &["openid"])
            },
        )
    }

    fn issue_code(store: &FakeGrantStore, client_id: &str, scopes: &[&str]) -> String {
        let code = generate_authorization_code();
        let now = Utc::now();
        store
            .tx()
            .issue_authorization_code(&AuthorizationCode {
                code: code.clone(),
                request_id: "req".to_owned(),
                client_id: client_id.to_owned(),
                redirect_uri: url::Url::parse("https://example.com/cb").unwrap(),
                code_challenge: compute_code_challenge(VERIFIER),
                granted_scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
                patient: None,
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
                sid: FIXTURE_SID.to_owned(),
            })
            .unwrap();
        code
    }

    /// The grant-type gate runs before anything is redeemed: a client not
    /// registered for the grant is refused and its code survives.
    #[test]
    fn a_client_without_the_grant_type_is_refused_before_redemption() {
        let exchanger = exchanger();
        let client = authenticated(&exchanger.store, "app", &[AllowedGrantType::DeviceCode]);
        let code = issue_code(&exchanger.store, "app", &["openid"]);
        let outcome = exchanger.exchange_authorization_code(
            &client,
            &PresentedAuthorizationCode {
                code: &code,
                code_verifier: VERIFIER,
                redirect_uri: "https://example.com/cb",
            },
            Utc::now(),
        );
        assert!(matches!(
            outcome,
            Err(TokenExchangeError::UnauthorizedGrantType)
        ));
        assert!(
            exchanger
                .store
                .tx()
                .authorization_code_by_request_id("req")
                .unwrap()
                .is_some(),
            "the code was not consumed"
        );
    }

    /// The code flow end to end: a token for the code's granted scopes, issued
    /// by and for the server's origin, and a refresh token only when
    /// `offline_access` was granted.
    #[test]
    fn a_code_exchange_mints_for_the_granted_scopes() {
        let exchanger = exchanger();
        let client = authenticated(&exchanger.store, "app", &AllowedGrantType::ALL);
        let plain = issue_code(&exchanger.store, "app", &["openid"]);
        let token = exchanger
            .exchange_authorization_code(
                &client,
                &PresentedAuthorizationCode {
                    code: &plain,
                    code_verifier: VERIFIER,
                    redirect_uri: "https://example.com/cb",
                },
                Utc::now(),
            )
            .expect("exchanges");
        assert_eq!(token.granted_scopes, ["openid"]);
        let claims = verify_jwt(
            &token.access_token,
            &exchanger.store.tx().all_signing_keys().unwrap(),
            &VerifyOptions {
                expected_issuer: SERVER_ORIGIN,
                accepted_audiences: &[SERVER_ORIGIN.to_owned()],
            },
        )
        .expect("the token names the server's origin as iss and aud");
        assert_eq!(claims.audience, [SERVER_ORIGIN]);
        assert_eq!(token.refresh_token, None);
        assert_eq!(token.expires_in, ACCESS_TOKEN_TTL.num_seconds());

        let host = authenticated(&exchanger.store, "host", &AllowedGrantType::ALL);
        let plain = issue_code(&exchanger.store, "host", &["openid", "offline_access"]);
        let token = exchanger
            .exchange_authorization_code(
                &host,
                &PresentedAuthorizationCode {
                    code: &plain,
                    code_verifier: VERIFIER,
                    redirect_uri: "https://example.com/cb",
                },
                Utc::now(),
            )
            .expect("exchanges");
        assert!(token.refresh_token.is_some());
    }

    /// The refresh flow: rotation returns a successor, and presenting the spent
    /// token again is a replay that revokes the family so the successor no
    /// longer works either.
    #[test]
    fn a_refresh_exchange_rotates_and_a_replay_revokes_the_family() {
        let exchanger = exchanger();
        seed_fixture_browser_session(&exchanger.store);
        let client = authenticated(&exchanger.store, "app", &AllowedGrantType::ALL);
        let plain = issue_code(&exchanger.store, "app", &["openid", "offline_access"]);
        let now = Utc::now();
        let first = exchanger
            .exchange_authorization_code(
                &client,
                &PresentedAuthorizationCode {
                    code: &plain,
                    code_verifier: VERIFIER,
                    redirect_uri: "https://example.com/cb",
                },
                now,
            )
            .unwrap()
            .refresh_token
            .unwrap();

        let rotated = exchanger
            .exchange_refresh_token(&client, &first, now)
            .expect("rotates");
        let successor = rotated.refresh_token.expect("successor issued");
        assert_eq!(rotated.granted_scopes, ["openid", "offline_access"]);

        let replay = exchanger.exchange_refresh_token(&client, &first, now + Duration::seconds(1));
        assert!(matches!(
            replay,
            Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenReplayed { .. }
            ))
        ));
        let after_revoke =
            exchanger.exchange_refresh_token(&client, &successor, now + Duration::seconds(2));
        assert!(matches!(
            after_revoke,
            Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenExpired
            ))
        ));
    }
}
