//! [`AuthenticatedClient`] — the proof that an OAuth client has authenticated
//! (RFC 6749 §2.3): it exists, is not disabled, and — for a confidential client
//! — presented the secret matching its stored argon2id hash. Its one
//! constructor, [`AuthenticatedClient::authenticate`], is the whole of that
//! rule. Anything a client does on its own behalf (redeem a grant, start a
//! device pairing) takes one of these, so a flow cannot act for a client whose
//! secret was never checked.

use crate::crypto_util::client_secret::verify_client_secret;
use crate::domain::client::{AllowedGrantType, Client, ClientKind, RegisteredRedirectUri};
use crate::domain::client_credentials::ClientCredentials;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// A client whose credentials have been verified. It answers the questions a
/// flow asks of the client it acts for (its id, name, and what its registration
/// allows); the row itself is private and there is no other constructor.
#[derive(Debug)]
pub(crate) struct AuthenticatedClient {
    client: Client,
}

/// The ways client authentication can fail. The first five are the caller's
/// fault and render as `401 invalid_client` (the description names which);
/// the last two are server-side and render as `500 server_error`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ClientAuthenticationError {
    /// No client row has this `client_id`.
    UnknownClient,
    /// The row exists but an admin disabled it.
    Disabled,
    /// A confidential client with no stored secret hash — a misconfigured
    /// registration, refused rather than admitted secret-less.
    SecretNotConfigured,
    /// A confidential client that presented no secret.
    SecretRequired,
    /// The presented secret does not match the stored hash.
    SecretMismatch,
    /// The stored hash could not be verified (malformed PHC string).
    Verification(String),
    /// The client row could not be read.
    Store(GatekeeperError),
}

impl AuthenticatedClient {
    /// Look up the client the credentials name and verify them: unknown and
    /// disabled clients are refused; a public client passes on identity alone; a
    /// confidential client must present the secret matching its stored argon2id
    /// PHC string (compared in constant time inside the verifier).
    ///
    /// # Errors
    ///
    /// A [`ClientAuthenticationError`] naming the failed check.
    pub(crate) fn authenticate(
        store: &impl GatekeeperStore,
        presented: &ClientCredentials,
    ) -> Result<Self, ClientAuthenticationError> {
        let client = store
            .client_by_id(&presented.client_id)
            .map_err(ClientAuthenticationError::Store)?
            .ok_or(ClientAuthenticationError::UnknownClient)?;
        if client.disabled_at.is_some() {
            return Err(ClientAuthenticationError::Disabled);
        }
        if matches!(client.kind, ClientKind::Public) {
            return Ok(AuthenticatedClient { client });
        }
        let stored_hash = client
            .secret_hash
            .as_deref()
            .ok_or(ClientAuthenticationError::SecretNotConfigured)?;
        let secret = presented
            .client_secret
            .as_deref()
            .ok_or(ClientAuthenticationError::SecretRequired)?;
        let matches = verify_client_secret(secret, stored_hash)
            .map_err(|e| ClientAuthenticationError::Verification(e.to_string()))?;
        if !matches {
            return Err(ClientAuthenticationError::SecretMismatch);
        }
        Ok(AuthenticatedClient { client })
    }

    /// The verified client's id.
    pub(crate) fn client_id(&self) -> &str {
        &self.client.client_id
    }

    /// The verified client's redirect allowlist.
    pub(crate) fn redirect_uris(&self) -> &[RegisteredRedirectUri] {
        &self.client.redirect_uris
    }

    /// The verified client's display name.
    pub(crate) fn name(&self) -> &str {
        &self.client.name
    }

    /// Whether the client's registration lists `grant_type`.
    pub(crate) fn allows_grant_type(&self, grant_type: AllowedGrantType) -> bool {
        self.client.allowed_grant_types.contains(&grant_type)
    }

    /// Whether the client's registration covers every one of `requested_scopes`
    /// (see [`Client::allows_scopes`]).
    pub(crate) fn allows_scopes(&self, requested_scopes: &[String]) -> bool {
        self.client.allows_scopes(requested_scopes)
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::crypto_util::client_secret::hash_client_secret;
    use crate::domain::test_fake::{client, FakeGatekeeperStore};

    fn presented(client_id: &str, secret: Option<&str>) -> ClientCredentials {
        ClientCredentials {
            client_id: client_id.to_owned(),
            client_secret: secret.map(str::to_owned),
        }
    }

    fn confidential(client_id: &str, secret: &str) -> Client {
        Client {
            kind: ClientKind::Confidential,
            secret_hash: Some(hash_client_secret(secret).expect("hash")),
            ..client(client_id, &["openid"])
        }
    }

    /// A public client authenticates on identity alone, with or without a
    /// stray secret.
    #[test]
    fn a_public_client_authenticates_on_identity_alone() {
        let store = FakeGatekeeperStore::default();
        store.upsert_client(&client("app", &["openid"])).unwrap();
        let proof =
            AuthenticatedClient::authenticate(&store, &presented("app", None)).expect("public");
        assert_eq!(proof.client_id(), "app");
        assert_eq!(proof.name(), "app display name");
        assert!(AuthenticatedClient::authenticate(&store, &presented("app", Some("x"))).is_ok());
    }

    /// Unknown and disabled clients are refused before any secret is looked at.
    #[test]
    fn unknown_and_disabled_clients_are_refused() {
        let store = FakeGatekeeperStore::default();
        store
            .upsert_client(&Client {
                disabled_at: Some(Utc::now()),
                ..confidential("gone", "s3cret")
            })
            .unwrap();
        assert_eq!(
            AuthenticatedClient::authenticate(&store, &presented("ghost", None)).unwrap_err(),
            ClientAuthenticationError::UnknownClient
        );
        assert_eq!(
            AuthenticatedClient::authenticate(&store, &presented("gone", Some("s3cret")))
                .unwrap_err(),
            ClientAuthenticationError::Disabled
        );
    }

    /// A confidential client needs the matching secret: absent, wrong, and
    /// unconfigured each name their own failure; the right one authenticates.
    #[test]
    fn a_confidential_client_needs_the_matching_secret() {
        let store = FakeGatekeeperStore::default();
        store.upsert_client(&confidential("app", "s3cret")).unwrap();
        store
            .upsert_client(&Client {
                secret_hash: None,
                ..confidential("broken", "irrelevant")
            })
            .unwrap();
        assert_eq!(
            AuthenticatedClient::authenticate(&store, &presented("app", None)).unwrap_err(),
            ClientAuthenticationError::SecretRequired
        );
        assert_eq!(
            AuthenticatedClient::authenticate(&store, &presented("app", Some("wrong")))
                .unwrap_err(),
            ClientAuthenticationError::SecretMismatch
        );
        assert_eq!(
            AuthenticatedClient::authenticate(&store, &presented("broken", Some("s3cret")))
                .unwrap_err(),
            ClientAuthenticationError::SecretNotConfigured
        );
        assert!(
            AuthenticatedClient::authenticate(&store, &presented("app", Some("s3cret"))).is_ok()
        );
    }

    /// The proof answers for the registration it verified: its grant types
    /// and its scope allowlist (coverage-aware, like [`Client::allows_scopes`]).
    #[test]
    fn the_proof_answers_for_its_registration() {
        let store = FakeGatekeeperStore::default();
        store
            .upsert_client(&Client {
                allowed_grant_types: vec![AllowedGrantType::DeviceCode],
                ..client("app", &["patient/*.rs"])
            })
            .unwrap();
        let proof = AuthenticatedClient::authenticate(&store, &presented("app", None))
            .expect("a public client authenticates");
        assert!(proof.allows_grant_type(AllowedGrantType::DeviceCode));
        assert!(!proof.allows_grant_type(AllowedGrantType::RefreshToken));
        assert!(proof.allows_scopes(&["patient/Observation.r".to_owned()]));
        assert!(!proof.allows_scopes(&["patient/Observation.c".to_owned()]));
    }
}
