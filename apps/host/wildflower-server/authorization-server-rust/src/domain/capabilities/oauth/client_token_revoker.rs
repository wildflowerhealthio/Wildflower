//! [`ClientTokenRevoker`] — `/oauth/revoke` (RFC 7009): an
//! [`AuthenticatedClient`] revokes one of its own tokens. A refresh token ends
//! its whole family; an access token is added to the `jti` denylist until it
//! expires.
//!
//! A token the server doesn't know, one that is already dead, and one issued
//! to another client are all left alone and answered alike (RFC 7009 §2.2), so
//! a caller learns nothing about a token that isn't its own.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::crypto_util::random_token::token_storage_hash;
use crate::domain::authority::AuthenticatedClient;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::{RefreshTokensTx, SigningKeysTx as _};
use crate::domain::refresh_token::RefreshTokenFamily;
use crate::domain::signing_key::SigningKey;
use crate::domain::token::{verify_jwt, VerifyError, VerifyOptions};
use crate::domain::GrantStore;
use crate::ports::Revocation;

/// The audit `reason` a denylist row written by `/oauth/revoke` carries.
const CLIENT_REVOCATION_REASON: &str = "client revocation";

/// Revoke a client's own tokens. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct ClientTokenRevoker<S: GrantStore> {
    store: S,
    revocation: Arc<dyn Revocation>,
    /// The server's bare origin: the one `iss` and `aud` an access token this
    /// server minted carries.
    server_origin: Arc<str>,
}

impl<S: GrantStore> ClientTokenRevoker<S> {
    /// Build the revoker over the store, the revocation port and the server's
    /// origin, all lifted from the state.
    pub(crate) fn new(store: S, revocation: Arc<dyn Revocation>, server_origin: Arc<str>) -> Self {
        ClientTokenRevoker {
            store,
            revocation,
            server_origin,
        }
    }

    /// Revoke `presented_token` if it is one of `authenticated_client`'s. The
    /// token's type is told from the token itself, so the request's
    /// `token_type_hint` is never needed: a refresh token is found by its
    /// storage hash and its family ended in the one write scope, and anything
    /// else is tried as an access token once the scope has closed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] when the refresh-token,
    /// signing-key or revocation store can't be read or written, or when an
    /// access token can't be verified for want of a usable key (no signing
    /// keys stored, or a key's material unreadable). Nothing about the token
    /// itself is an error.
    pub(crate) fn revoke(
        &self,
        authenticated_client: &AuthenticatedClient,
        presented_token: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        let presented_hash = token_storage_hash(presented_token);
        let presented = self
            .store
            .write(|tx| -> Result<_, AuthorizationServerError> {
                match tx.refresh_token_with_family_by_hash(&presented_hash)? {
                    Some((_, family)) => {
                        end_refresh_family(tx, authenticated_client, &family, now)?;
                        Ok(PresentedToken::RefreshToken)
                    }
                    None => Ok(PresentedToken::NoRefreshToken {
                        signing_keys: tx.all_signing_keys()?,
                    }),
                }
            })?;
        match presented {
            PresentedToken::RefreshToken => Ok(()),
            PresentedToken::NoRefreshToken { signing_keys } => {
                self.denylist_access_token(authenticated_client, presented_token, &signing_keys)
            }
        }
    }

    /// Denylist a presented access token until its own expiry when this server
    /// minted it for the client, verified against `signing_keys`. A token that
    /// fails verification (forged, expired, another server's) can't be used
    /// anyway, so there is nothing to revoke.
    fn denylist_access_token(
        &self,
        authenticated_client: &AuthenticatedClient,
        presented_token: &str,
        signing_keys: &[SigningKey],
    ) -> Result<(), AuthorizationServerError> {
        let claims = match verify_jwt(
            presented_token,
            signing_keys,
            &VerifyOptions {
                expected_issuer: &self.server_origin,
                accepted_audiences: &[self.server_origin.to_string()],
            },
        ) {
            Ok(claims) => claims,
            Err(VerifyError::TokenRejected) => return Ok(()),
            Err(error) => {
                return Err(AuthorizationServerError::infrastructure(
                    "access-token verification failed during revocation",
                    error,
                ))
            }
        };
        if claims.subject != authenticated_client.client_id() {
            tracing::info!(
                token_client_id = %claims.subject,
                presented_client_id = authenticated_client.client_id(),
                "revocation presented another client's access token; left alone"
            );
            return Ok(());
        }
        // Every token this server mints carries both; verification tolerates
        // one without a `jti`, which can't be denylisted on its own.
        let (Some(jti), Some(expires_at)) = (claims.jti.as_deref(), claims.expires_at) else {
            return Ok(());
        };
        self.revocation
            .revoke_jti(jti, expires_at, CLIENT_REVOCATION_REASON)
            .map_err(|error| AuthorizationServerError::infrastructure("revoke_jti failed", error))
    }
}

/// What the revoke scope found the presented token to be.
enum PresentedToken {
    /// A refresh token: its family was handled inside the scope.
    RefreshToken,
    /// No refresh token this server stores: what remains is to try it as an
    /// access token, against the signing keys the scope read.
    NoRefreshToken { signing_keys: Vec<SigningKey> },
}

/// End the family a presented refresh token belongs to, any of its
/// generations, when it is the client's and still alive, in the caller's
/// scope `tx`. A family that has already ended keeps the instant it ended at.
fn end_refresh_family(
    tx: &mut impl RefreshTokensTx,
    authenticated_client: &AuthenticatedClient,
    family: &RefreshTokenFamily,
    now: DateTime<Utc>,
) -> Result<(), AuthorizationServerError> {
    if family.client_id != authenticated_client.client_id() {
        tracing::info!(
            family_id = %family.family_id,
            presented_client_id = authenticated_client.client_id(),
            "revocation presented another client's refresh token; left alone"
        );
        return Ok(());
    }
    if family.expires_at <= now {
        return Ok(());
    }
    tx.expire_refresh_token_family(&family.family_id, now)
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;
    use wildflowerhealthio_token_revocation::RevocationStore;

    use super::*;
    use crate::crypto_util::base64;
    use crate::domain::refresh_token::RefreshToken;
    use crate::domain::test_fake::{
        authenticated_public_client, client, seed_active_signing_key, FakeGrantStore,
    };
    use crate::domain::token::{mint_access_token, NewJwtArgs};

    const SERVER_ORIGIN: &str = "https://ruth.relay.example";

    /// A revoker over a fresh fake store with a signing key, and the real
    /// revocation store it writes to.
    fn revoker() -> (ClientTokenRevoker<FakeGrantStore>, RevocationStore) {
        let store = FakeGrantStore::default();
        seed_active_signing_key(&store);
        let revocation_store = RevocationStore::open_in_memory().expect("revocation store");
        let revoker = ClientTokenRevoker::new(
            store,
            Arc::new(revocation_store.clone()),
            SERVER_ORIGIN.into(),
        );
        (revoker, revocation_store)
    }

    fn authenticated(store: &FakeGrantStore, client_id: &str) -> AuthenticatedClient {
        authenticated_public_client(store, client(client_id, &["openid"]))
    }

    /// Plant a family for `client_id` whose one live token is `plaintext`.
    fn plant_family(store: &FakeGrantStore, client_id: &str, plaintext: &str, now: DateTime<Utc>) {
        store
            .tx()
            .insert_refresh_token_family_row(&RefreshTokenFamily {
                family_id: format!("family-{plaintext}"),
                client_id: client_id.to_owned(),
                scopes: vec!["openid".to_owned(), "offline_access".to_owned()],
                patient: None,
                issued_at: now,
                expires_at: now + Duration::days(30),
                authorization_code_hash: None,
                grant_id: None,
                sid: None,
            })
            .unwrap();
        store
            .tx()
            .insert_refresh_token(&RefreshToken {
                token_hash: token_storage_hash(plaintext),
                family_id: format!("family-{plaintext}"),
                issued_at: now,
                consumed_at: None,
            })
            .unwrap();
    }

    fn family_expires_at(store: &FakeGrantStore, plaintext: &str) -> DateTime<Utc> {
        store
            .tx()
            .refresh_token_with_family_by_hash(&token_storage_hash(plaintext))
            .unwrap()
            .expect("planted")
            .1
            .expires_at
    }

    /// An access token for `client_id`, signed by the store's key and naming
    /// `issuer` as `iss` and `aud`.
    fn access_token(store: &FakeGrantStore, client_id: &str, issuer: &str) -> String {
        let key = store
            .tx()
            .active_signing_key()
            .unwrap()
            .expect("seeded key");
        mint_access_token(
            &key,
            &NewJwtArgs {
                client_id,
                scopes: &["openid".to_owned()],
                ttl: Duration::minutes(5),
                issuer,
                audience: Some(issuer),
                patient: None,
                sid: None,
            },
        )
        .unwrap()
    }

    fn jti_is_denylisted(revocation_store: &RevocationStore, access_token: &str) -> bool {
        let payload = access_token.split('.').nth(1).expect("a JWT");
        let claims: serde_json::Value =
            serde_json::from_slice(&base64::url_safe_no_pad_decode(payload).expect("base64url"))
                .unwrap();
        revocation_store
            .is_revoked_by_jti(claims["jti"].as_str().expect("jti"))
            .unwrap()
    }

    /// The client's own refresh token ends its family now; another client's
    /// is left alone, and a family that already ended keeps its end.
    #[test]
    fn a_refresh_token_ends_its_family_only_for_its_own_client() {
        let (revoker, _) = revoker();
        let now = Utc::now();
        let app = authenticated(&revoker.store, "app");
        let stranger = authenticated(&revoker.store, "stranger");
        plant_family(&revoker.store, "app", "refresh", now);

        revoker.revoke(&stranger, "refresh", now).unwrap();
        assert!(family_expires_at(&revoker.store, "refresh") > now);

        revoker.revoke(&app, "refresh", now).unwrap();
        assert_eq!(family_expires_at(&revoker.store, "refresh"), now);

        revoker
            .revoke(&app, "refresh", now + Duration::minutes(1))
            .unwrap();
        assert_eq!(
            family_expires_at(&revoker.store, "refresh"),
            now,
            "revoking an ended family doesn't move its end"
        );
    }

    /// The client's own access token is denylisted; another client's, one
    /// minted for another server, and garbage are all left alone.
    #[test]
    fn an_access_token_is_denylisted_only_for_its_own_client() {
        let (revoker, revocation_store) = revoker();
        let now = Utc::now();
        let app = authenticated(&revoker.store, "app");
        let stranger = authenticated(&revoker.store, "stranger");

        let own = access_token(&revoker.store, "app", SERVER_ORIGIN);
        revoker.revoke(&stranger, &own, now).unwrap();
        assert!(!jti_is_denylisted(&revocation_store, &own));
        revoker.revoke(&app, &own, now).unwrap();
        assert!(jti_is_denylisted(&revocation_store, &own));

        let foreign = access_token(&revoker.store, "app", "https://other.example");
        revoker.revoke(&app, &foreign, now).unwrap();
        assert!(!jti_is_denylisted(&revocation_store, &foreign));

        revoker.revoke(&app, "not-a-token", now).unwrap();
    }
}
