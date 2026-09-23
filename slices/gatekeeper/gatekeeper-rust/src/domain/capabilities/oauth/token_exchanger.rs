//! [`TokenExchanger`] — the `/oauth/token` flows (RFC 6749 §4.1.3, RFC 8628
//! §3.4, RFC 6749 §6). Each reads top to bottom as: check the client may use
//! the grant type, obtain the redemption proof, mint under it, then (for the
//! two session-establishing grants) start a refresh family, or (for a refresh)
//! rotate. The proof is the hand-off between the validation half and the
//! writers, so a token is never minted for a grant that didn't redeem.

use chrono::{DateTime, Utc};

use crate::domain::authority::{
    AuthenticatedClient, ConsumedDeviceRequest, GrantRedemption, PresentedAuthorizationCode,
    RedeemedAuthorizationCode, TokenEntitlement, ValidatedRefreshToken,
};
use crate::domain::capabilities::writers::{AccessTokenMinter, RefreshFamilyWriter};
use crate::domain::client::AllowedGrantType;
use crate::domain::token::ACCESS_TOKEN_TTL;
use crate::domain::token_exchange_error::TokenExchangeError;
use crate::domain::GatekeeperStore;

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

/// Exchange grants for tokens on behalf of an [`AuthenticatedClient`]. Generic
/// over the store port so it's unit-testable against the fake; the binding
/// instantiates it over the concrete `SqliteGatekeeperStore`.
pub(crate) struct TokenExchanger<S: GatekeeperStore> {
    store: S,
}

impl<S: GatekeeperStore> TokenExchanger<S> {
    /// Build the exchanger over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        TokenExchanger { store }
    }

    /// Redeem an authorization code with its PKCE verifier (RFC 6749 §4.1.3,
    /// RFC 7636 §4.6) and mint the token the code's consent authorized.
    /// `served_origin` is the served served_origin the token's `aud` is bound to.
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
        served_origin: &str,
        now: DateTime<Utc>,
    ) -> Result<IssuedTokens, TokenExchangeError> {
        self.ensure_grant_type_allowed(authenticated_client, AllowedGrantType::AuthorizationCode)?;
        let redeemed_code =
            RedeemedAuthorizationCode::redeem(&self.store, authenticated_client, presented, now)?;
        self.issue_for_redemption(
            GrantRedemption::AuthorizationCode(&redeemed_code),
            served_origin,
            now,
        )
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
        served_origin: &str,
        now: DateTime<Utc>,
    ) -> Result<IssuedTokens, TokenExchangeError> {
        self.ensure_grant_type_allowed(authenticated_client, AllowedGrantType::DeviceCode)?;
        let consumed_device_request =
            ConsumedDeviceRequest::consume(&self.store, authenticated_client, device_code, now)?;
        self.issue_for_redemption(
            GrantRedemption::DeviceCode(&consumed_device_request),
            served_origin,
            now,
        )
    }

    /// Trade a live refresh token for a fresh access token and the refresh
    /// token's successor (RFC 6749 §6, OAuth 2.1 rotation). The access token is
    /// minted **before** the rotation mutates anything, so a signing failure
    /// returns without burning the presented token. The family keeps its scopes
    /// and absolute deadline — rotation never extends its life.
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
        served_origin: &str,
        now: DateTime<Utc>,
    ) -> Result<IssuedTokens, TokenExchangeError> {
        self.ensure_grant_type_allowed(authenticated_client, AllowedGrantType::RefreshToken)?;
        let validated_refresh_token = ValidatedRefreshToken::validate(
            &self.store,
            authenticated_client,
            presented_refresh_token,
            now,
        )?;
        let access_token = self.mint(
            TokenEntitlement::RefreshToken(&validated_refresh_token),
            served_origin,
        )?;
        let successor =
            RefreshFamilyWriter::over(&self.store).rotate(&validated_refresh_token, now)?;
        Ok(IssuedTokens {
            access_token,
            expires_in: ACCESS_TOKEN_TTL.num_seconds(),
            granted_scopes: validated_refresh_token.granted_scopes().to_vec(),
            refresh_token: Some(successor),
            patient: validated_refresh_token.patient().map(str::to_owned),
        })
    }

    /// The registration must list the grant type the client is using.
    fn ensure_grant_type_allowed(
        &self,
        authenticated_client: &AuthenticatedClient,
        grant_type: AllowedGrantType,
    ) -> Result<(), TokenExchangeError> {
        if authenticated_client.allows_grant_type(grant_type) {
            Ok(())
        } else {
            Err(TokenExchangeError::UnauthorizedGrantType)
        }
    }

    /// Mint under a redemption and start its refresh family if the grant earned
    /// one (the mint comes first so a signing failure creates no credential).
    fn issue_for_redemption(
        &self,
        redemption: GrantRedemption<'_>,
        served_origin: &str,
        now: DateTime<Utc>,
    ) -> Result<IssuedTokens, TokenExchangeError> {
        let access_token = self.mint(redemption.entitlement(), served_origin)?;
        let refresh_token = if redemption.earns_refresh_token() {
            Some(RefreshFamilyWriter::over(&self.store).start_family(redemption, now)?)
        } else {
            None
        };
        Ok(IssuedTokens {
            access_token,
            expires_in: ACCESS_TOKEN_TTL.num_seconds(),
            granted_scopes: redemption.granted_scopes().to_vec(),
            refresh_token,
            patient: redemption.patient().map(str::to_owned),
        })
    }

    /// Mint an OAuth access token: `iss` is the canonical issuer, `aud` this
    /// request's served origin's FHIR base (see `docs/Origins/Explanation.md`).
    fn mint(
        &self,
        entitlement: TokenEntitlement<'_>,
        served_origin: &str,
    ) -> Result<String, TokenExchangeError> {
        let audience = format!("{served_origin}/fhir-r4");
        let minter = AccessTokenMinter::new(
            &self.store,
            shared_structures_rust::CANONICAL_ISSUER,
            &audience,
            ACCESS_TOKEN_TTL,
        );
        Ok(minter.mint(entitlement)?)
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use crate::domain::token_exchange_error::InvalidGrantReason;

    use super::*;
    use crate::crypto_util::pkce::compute_code_challenge;
    use crate::crypto_util::random_token::generate_authorization_code;
    use crate::domain::authorization_code::{IssuedAuthorizationCode, AUTHORIZATION_CODE_TTL};
    use crate::domain::client::Client;

    use crate::domain::test_fake::{
        authenticated_public_client, client, seed_active_signing_key, FakeGatekeeperStore,
    };

    const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-1";

    fn exchanger() -> TokenExchanger<FakeGatekeeperStore> {
        let store = FakeGatekeeperStore::default();
        seed_active_signing_key(&store);
        TokenExchanger::new(store)
    }

    fn authenticated(
        store: &FakeGatekeeperStore,
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

    fn issue_code(store: &FakeGatekeeperStore, client_id: &str, scopes: &[&str]) -> String {
        let code = generate_authorization_code();
        let now = Utc::now();
        store
            .issue_authorization_code(&IssuedAuthorizationCode {
                code: code.clone(),
                request_id: "req".to_owned(),
                client_id: client_id.to_owned(),
                redirect_uri: url::Url::parse("https://example.com/cb").unwrap(),
                code_challenge: compute_code_challenge(VERIFIER),
                granted_scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
                patient: None,
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
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
            "http://127.0.0.1",
            Utc::now(),
        );
        assert!(matches!(
            outcome,
            Err(TokenExchangeError::UnauthorizedGrantType)
        ));
        assert!(
            exchanger
                .store
                .authorization_code_by_request_id("req")
                .unwrap()
                .is_some(),
            "the code was not consumed"
        );
    }

    /// The code flow end to end: a token for the code's granted scopes, a
    /// refresh token only when `offline_access` was granted, and the
    /// first-party flag keyed on the redeeming client.
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
                "http://127.0.0.1",
                Utc::now(),
            )
            .expect("exchanges");
        assert_eq!(token.granted_scopes, ["openid"]);
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
                "http://127.0.0.1",
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
                "http://127.0.0.1",
                now,
            )
            .unwrap()
            .refresh_token
            .unwrap();

        let rotated = exchanger
            .exchange_refresh_token(&client, &first, "http://127.0.0.1", now)
            .expect("rotates");
        let successor = rotated.refresh_token.expect("successor issued");
        assert_eq!(rotated.granted_scopes, ["openid", "offline_access"]);

        let replay = exchanger.exchange_refresh_token(
            &client,
            &first,
            "http://127.0.0.1",
            now + Duration::seconds(1),
        );
        assert!(matches!(
            replay,
            Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenReplayed { .. }
            ))
        ));
        let after_revoke = exchanger.exchange_refresh_token(
            &client,
            &successor,
            "http://127.0.0.1",
            now + Duration::seconds(2),
        );
        assert!(matches!(
            after_revoke,
            Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenExpired
            ))
        ));
    }
}
