//! [`RefreshFamilyWriter`] — the writer that issues standing credentials: it
//! starts a refresh-token family for a grant redemption, and rotates a
//! validated refresh token into its successor. Both take a
//! redemption proof, so a refresh token is only ever minted for scopes a
//! consumed code or claimed device request recorded.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::crypto_util::random_token::{generate_refresh_token, token_storage_hash};
use crate::domain::authority::{GrantRedemption, ValidatedRefreshToken};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::refresh_token::{
    consume_refresh_token, RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily,
    REFRESH_TOKEN_FAMILY_TTL,
};
use crate::domain::token_exchange_error::{InvalidGrantReason, TokenExchangeError};
use crate::domain::GrantTx;

/// Issue and rotate refresh tokens, inside the caller's transaction; the
/// gate is the redemption proof each method takes.
pub(crate) struct RefreshFamilyWriter<'a, T: GrantTx> {
    tx: &'a mut T,
}

impl<'a, T: GrantTx> RefreshFamilyWriter<'a, T> {
    /// A writer inside the caller's transaction `tx`.
    pub(crate) fn within(tx: &'a mut T) -> Self {
        RefreshFamilyWriter { tx }
    }

    /// Mint a new family with its first token and return the token's
    /// plaintext. The caller checks
    /// [`earns_refresh_token`](GrantRedemption::earns_refresh_token) first. The
    /// family records the redemption's scopes and patient verbatim, the code
    /// it consumed (so a replay of that code can revoke the lineage), the
    /// standing grant behind it, and the browser session it was made under (so
    /// revoking that session ends it).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn start_family(
        &mut self,
        redemption: GrantRedemption<'_>,
        now: DateTime<Utc>,
    ) -> Result<String, AuthorizationServerError> {
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
            sid: redemption.sid().map(str::to_owned),
        };
        let first_token = RefreshToken {
            token_hash: token_storage_hash(&plaintext),
            family_id: family.family_id.clone(),
            issued_at: now,
            consumed_at: None,
        };
        self.tx.insert_refresh_token_family_row(&family)?;
        self.tx.insert_refresh_token(&first_token)?;
        Ok(plaintext)
    }

    /// Consume the presented token and, only if that consume won, insert its
    /// successor and return the successor's plaintext. A family made under a
    /// browser session moves that session's `last_seen_at` to `now`: an app
    /// refreshing is the session in use.
    ///
    /// A refusal is the inner `Err`, so the caller's scope keeps what it
    /// wrote: [`InvalidGrantReason::RefreshTokenReplayed`] when the token had
    /// already been consumed — a leak or a badly broken client, either way an
    /// unsafe lineage, so the whole family is expired at `now` first; and
    /// [`InvalidGrantReason::RefreshTokenVanished`] when it disappeared between
    /// validation and rotation (nothing to revoke).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn rotate(
        &mut self,
        validated_refresh_token: &ValidatedRefreshToken,
        now: DateTime<Utc>,
    ) -> Result<Result<String, TokenExchangeError>, AuthorizationServerError> {
        let family_id = validated_refresh_token.family_id();
        match consume_refresh_token(self.tx, validated_refresh_token.presented_hash(), now)? {
            RefreshTokenConsumeOutcome::Consumed => {
                let successor = generate_refresh_token();
                self.tx.insert_refresh_token(&RefreshToken {
                    token_hash: token_storage_hash(&successor),
                    family_id: family_id.to_owned(),
                    issued_at: now,
                    consumed_at: None,
                })?;
                if let Some(sid) = validated_refresh_token.sid() {
                    self.tx.touch_browser_session_last_seen(sid, now, now)?;
                }
                Ok(Ok(successor))
            }
            RefreshTokenConsumeOutcome::Replayed => {
                self.tx.expire_refresh_token_family(family_id, now)?;
                Ok(Err(TokenExchangeError::InvalidGrant(
                    InvalidGrantReason::RefreshTokenReplayed {
                        family_id: family_id.to_owned(),
                        client_id: validated_refresh_token.client_id().to_owned(),
                    },
                )))
            }
            RefreshTokenConsumeOutcome::NotFound => Ok(Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenVanished {
                    family_id: family_id.to_owned(),
                },
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::grant_store::*;

    use crate::domain::test_fake::{
        authenticated_public_client, client, code_grant, redeemed_code,
        seed_fixture_browser_session, FakeGrantStore, NothingRevoked,
    };

    /// Only a grant carrying `offline_access` earns a refresh token.
    #[test]
    fn only_offline_access_earns_a_refresh_token() {
        let store = FakeGrantStore::default();
        let without = redeemed_code(&store, "a", &["openid"]);
        let with = redeemed_code(&store, "b", &["openid", "offline_access"]);
        assert!(!GrantRedemption::AuthorizationCode(&without).earns_refresh_token());
        assert!(GrantRedemption::AuthorizationCode(&with).earns_refresh_token());
    }

    /// The family records the redemption's scopes, patient, code hash, and
    /// grant, and the returned plaintext resolves to its first token.
    #[test]
    fn start_family_records_the_redemption() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .create_authorization_code_grant(&code_grant("grant-1", "client"))
            .unwrap();
        let redeemed_code = redeemed_code(&store, "client", &["openid", "offline_access"]);
        let now = Utc::now();
        let plaintext = RefreshFamilyWriter::within(&mut store.tx())
            .start_family(GrantRedemption::AuthorizationCode(&redeemed_code), now)
            .unwrap();
        let (token, family) = store
            .tx()
            .refresh_token_with_family_by_hash(&token_storage_hash(&plaintext))
            .unwrap()
            .expect("first token resolves");
        assert_eq!(token.consumed_at, None);
        assert_eq!(family.client_id, "client");
        assert_eq!(family.scopes, ["openid", "offline_access"]);
        assert_eq!(family.patient.as_deref(), Some("pat-1"));
        assert_eq!(
            family.authorization_code_hash.as_deref(),
            Some(token_storage_hash(redeemed_code.authorization_code()).as_str())
        );
        assert_eq!(family.grant_id.as_deref(), Some("grant-1"));
        assert_eq!(family.expires_at, now + REFRESH_TOKEN_FAMILY_TTL);
    }

    fn validated(store: &FakeGrantStore, plaintext: &str) -> ValidatedRefreshToken {
        let client = authenticated_public_client(store, client("client", &["openid"]));
        ValidatedRefreshToken::validate(
            &mut store.tx(),
            &NothingRevoked,
            &client,
            plaintext,
            Utc::now(),
        )
        .unwrap()
    }

    /// Rotating a family made under a browser session moves the session's
    /// `last_seen_at` to the rotation's instant; a family with no session
    /// touches none.
    #[test]
    fn rotate_marks_the_family_s_browser_session_seen() {
        use crate::domain::browser_session::BrowserSession;

        let store = FakeGrantStore::default();
        let mut tx = store.tx();
        let mut writer = RefreshFamilyWriter::within(&mut tx);
        let signed_in_at = Utc::now() - chrono::Duration::hours(1);
        let session = BrowserSession::new_owner(vec![], chrono::Duration::hours(8), signed_in_at);
        store.tx().insert_browser_session(&session).unwrap();
        for (family_id, sid) in [("under-session", Some(&session.sid)), ("no-session", None)] {
            store
                .tx()
                .insert_refresh_token_family_row(&RefreshTokenFamily {
                    family_id: family_id.to_owned(),
                    client_id: "client".to_owned(),
                    scopes: vec!["offline_access".to_owned()],
                    patient: None,
                    issued_at: signed_in_at,
                    expires_at: signed_in_at + REFRESH_TOKEN_FAMILY_TTL,
                    authorization_code_hash: None,
                    grant_id: None,
                    sid: sid.cloned(),
                })
                .unwrap();
            store
                .tx()
                .insert_refresh_token(&RefreshToken {
                    token_hash: token_storage_hash(family_id),
                    family_id: family_id.to_owned(),
                    issued_at: signed_in_at,
                    consumed_at: None,
                })
                .unwrap();
        }
        let last_seen = || {
            store
                .tx()
                .browser_session_by_sid(&session.sid)
                .unwrap()
                .unwrap()
                .last_seen_at
        };

        let rotated_at = Utc::now();
        writer
            .rotate(&validated(&store, "no-session"), rotated_at)
            .unwrap()
            .expect("rotates");
        assert_eq!(
            last_seen(),
            signed_in_at,
            "a family with no session touches none"
        );

        writer
            .rotate(&validated(&store, "under-session"), rotated_at)
            .unwrap()
            .expect("rotates");
        assert_eq!(last_seen(), rotated_at);
    }

    /// Rotation consumes the presented token and issues a live successor in the
    /// same family; presenting the consumed token again is a replay that
    /// expires the family, after which nothing in it validates.
    #[test]
    fn rotate_consumes_then_replay_expires_the_family() {
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        let mut tx = store.tx();
        let mut writer = RefreshFamilyWriter::within(&mut tx);
        let now = Utc::now();
        let redeemed_code = redeemed_code(&store, "client", &["offline_access"]);
        let first = writer
            .start_family(GrantRedemption::AuthorizationCode(&redeemed_code), now)
            .unwrap();
        let presented = validated(&store, &first);

        let successor = writer
            .rotate(&presented, now)
            .unwrap()
            .expect("first rotation rotates");
        assert!(store
            .tx()
            .refresh_token_with_family_by_hash(&token_storage_hash(&successor))
            .unwrap()
            .is_some());

        assert!(matches!(
            writer.rotate(&presented, now).unwrap(),
            Err(TokenExchangeError::InvalidGrant(
                InvalidGrantReason::RefreshTokenReplayed { .. }
            ))
        ));
        let (_, family) = store
            .tx()
            .refresh_token_with_family_by_hash(&token_storage_hash(&successor))
            .unwrap()
            .unwrap();
        assert_eq!(family.expires_at, now, "the whole family is expired");
    }
}
