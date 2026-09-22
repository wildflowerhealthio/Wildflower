//! [`RefreshFamilyWriter`] — the writer that issues standing credentials: it
//! starts a refresh-token family for a grant redemption that earned one, and
//! rotates a validated refresh token into its successor. Both take a
//! redemption proof, so a refresh token is only ever minted for scopes a
//! consumed code or claimed device request recorded.

use chrono::{DateTime, Utc};
use scopes_rust::KnownScope;
use uuid::Uuid;

use crate::crypto_util::random_token::{generate_refresh_token, token_storage_hash};
use crate::domain::authority::{GrantRedemption, ValidatedRefreshToken};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::refresh_token::{
    consume_refresh_token, RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily,
    REFRESH_TOKEN_FAMILY_TTL,
};
use crate::domain::GatekeeperStore;

/// What rotating a validated refresh token produced.
#[derive(Debug, PartialEq, Eq)]
#[must_use]
pub(crate) enum Rotation {
    /// The presented token is consumed and this is its successor's plaintext.
    Rotated { successor: String },
    /// The presented token had already been consumed — a leak or a badly broken
    /// client, either way an unsafe lineage: the whole family has been expired.
    Replayed,
    /// The token vanished between validation and rotation (a failed decode);
    /// nothing to revoke.
    Vanished,
}

/// Issue and rotate refresh tokens. A borrowed view over the store; the gate is
/// the redemption proof each method takes.
pub(crate) struct RefreshFamilyWriter<'a, S: GatekeeperStore> {
    store: &'a S,
}

impl<'a, S: GatekeeperStore> RefreshFamilyWriter<'a, S> {
    /// A writer over `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        RefreshFamilyWriter { store }
    }

    /// When the redemption's granted scopes carry
    /// [`KnownScope::OfflineAccess`], mint a new family with its first token and
    /// return the token's plaintext. Grants without the scope get `Ok(None)` —
    /// no standing credential is created. The family records the redemption's
    /// scopes and patient verbatim, the code it consumed (so a replay of that
    /// code can revoke the lineage), and the standing grant behind it.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn start_family_if_granted(
        &self,
        redemption: &impl GrantRedemption,
        now: DateTime<Utc>,
    ) -> Result<Option<String>, GatekeeperError> {
        if !redemption
            .granted_scopes()
            .iter()
            .any(|s| s == KnownScope::OfflineAccess.as_str())
        {
            return Ok(None);
        }
        let plaintext = generate_refresh_token();
        let family = RefreshTokenFamily {
            family_id: Uuid::new_v4().to_string(),
            client_id: redemption.client_id().to_owned(),
            scopes: redemption.granted_scopes().to_vec(),
            patient: redemption.patient().map(str::to_owned),
            issued_at: now,
            expires_at: now + REFRESH_TOKEN_FAMILY_TTL,
            authorization_code_hash: redemption.authorization_code().map(token_storage_hash),
            grant_id: redemption.grant_id().map(str::to_owned),
        };
        let first_token = RefreshToken {
            token_hash: token_storage_hash(&plaintext),
            family_id: family.family_id.clone(),
            issued_at: now,
            consumed_at: None,
        };
        self.store.insert_refresh_token_family_row(&family)?;
        self.store.insert_refresh_token(&first_token)?;
        Ok(Some(plaintext))
    }

    /// Consume the presented token and, only if that consume won, insert its
    /// successor. The consume is atomic on its own; the successor insert is
    /// ordered after it, so a failure of the insert leaves the presented token
    /// spent with no successor (a failed rotation the client recovers from by
    /// re-authorizing), never a usable extra token. A replay expires the whole
    /// family at `now` before returning.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn rotate(
        &self,
        token: &ValidatedRefreshToken,
        now: DateTime<Utc>,
    ) -> Result<Rotation, GatekeeperError> {
        match consume_refresh_token(self.store, token.presented_hash(), now)? {
            RefreshTokenConsumeOutcome::Consumed => {
                let successor = generate_refresh_token();
                self.store.insert_refresh_token(&RefreshToken {
                    token_hash: token_storage_hash(&successor),
                    family_id: token.family_id().to_owned(),
                    issued_at: now,
                    consumed_at: None,
                })?;
                Ok(Rotation::Rotated { successor })
            }
            RefreshTokenConsumeOutcome::Replayed => {
                self.store
                    .expire_refresh_token_family(token.family_id(), now)?;
                Ok(Rotation::Replayed)
            }
            RefreshTokenConsumeOutcome::NotFound => Ok(Rotation::Vanished),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authority::AuthenticatedClient;
    use crate::domain::client_credentials::ClientCredentials;
    use crate::domain::test_fake::{client, FakeGatekeeperStore};

    /// A stand-in redemption for the family-start tests: the proof types'
    /// constructors are exercised in `domain::authority`; here only the
    /// writer's reading of one matters.
    struct FakeRedemption {
        scopes: Vec<String>,
        code: Option<String>,
    }

    impl crate::domain::authority::sealed::Sealed for FakeRedemption {}

    impl crate::domain::authority::MintAuthority for FakeRedemption {
        fn client_id(&self) -> &str {
            "client"
        }
        fn scopes(&self) -> &[String] {
            &self.scopes
        }
        fn patient(&self) -> Option<&str> {
            Some("pat-1")
        }
        fn is_host_owner(&self) -> bool {
            false
        }
    }

    impl GrantRedemption for FakeRedemption {
        fn granted_scopes(&self) -> &[String] {
            &self.scopes
        }
        fn authorization_code(&self) -> Option<&str> {
            self.code.as_deref()
        }
        fn grant_id(&self) -> Option<&str> {
            Some("grant-1")
        }
    }

    fn owned(scopes: &[&str]) -> Vec<String> {
        scopes.iter().map(|s| (*s).to_owned()).collect()
    }

    /// Only a grant carrying `offline_access` starts a family; the family
    /// records the redemption's scopes, patient, code hash, and grant, and the
    /// returned plaintext resolves to its first token.
    #[test]
    fn start_family_only_for_offline_access_and_records_the_redemption() {
        let store = FakeGatekeeperStore::default();
        let writer = RefreshFamilyWriter::over(&store);
        let now = Utc::now();
        let none = writer
            .start_family_if_granted(
                &FakeRedemption {
                    scopes: owned(&["openid"]),
                    code: None,
                },
                now,
            )
            .unwrap();
        assert_eq!(none, None);

        let plaintext = writer
            .start_family_if_granted(
                &FakeRedemption {
                    scopes: owned(&["openid", "offline_access"]),
                    code: Some("the-code".to_owned()),
                },
                now,
            )
            .unwrap()
            .expect("offline_access earns a family");
        let (token, family) = store
            .refresh_token_with_family_by_hash(&token_storage_hash(&plaintext))
            .unwrap()
            .expect("first token resolves");
        assert_eq!(token.consumed_at, None);
        assert_eq!(family.client_id, "client");
        assert_eq!(family.scopes, ["openid", "offline_access"]);
        assert_eq!(family.patient.as_deref(), Some("pat-1"));
        assert_eq!(
            family.authorization_code_hash.as_deref(),
            Some(token_storage_hash("the-code").as_str())
        );
        assert_eq!(family.grant_id.as_deref(), Some("grant-1"));
        assert_eq!(family.expires_at, now + REFRESH_TOKEN_FAMILY_TTL);
    }

    fn validated(store: &FakeGatekeeperStore, plaintext: &str) -> ValidatedRefreshToken {
        store.upsert_client(&client("client", &["openid"])).unwrap();
        let client = AuthenticatedClient::authenticate(
            store,
            &ClientCredentials {
                client_id: "client".to_owned(),
                client_secret: None,
            },
        )
        .unwrap();
        ValidatedRefreshToken::validate(store, &client, plaintext, Utc::now()).unwrap()
    }

    /// Rotation consumes the presented token and issues a live successor in the
    /// same family; presenting the consumed token again is a replay that
    /// expires the family, after which nothing in it validates.
    #[test]
    fn rotate_consumes_then_replay_expires_the_family() {
        let store = FakeGatekeeperStore::default();
        let writer = RefreshFamilyWriter::over(&store);
        let now = Utc::now();
        let first = writer
            .start_family_if_granted(
                &FakeRedemption {
                    scopes: owned(&["offline_access"]),
                    code: None,
                },
                now,
            )
            .unwrap()
            .unwrap();
        let presented = validated(&store, &first);

        let Rotation::Rotated { successor } = writer.rotate(&presented, now).unwrap() else {
            panic!("first rotation rotates");
        };
        assert!(store
            .refresh_token_with_family_by_hash(&token_storage_hash(&successor))
            .unwrap()
            .is_some());

        assert_eq!(writer.rotate(&presented, now).unwrap(), Rotation::Replayed);
        let (_, family) = store
            .refresh_token_with_family_by_hash(&token_storage_hash(&successor))
            .unwrap()
            .unwrap();
        assert_eq!(family.expires_at, now, "the whole family is expired");
    }
}
