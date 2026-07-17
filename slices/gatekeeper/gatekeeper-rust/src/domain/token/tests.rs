use super::*;
use crate::domain::signing_key::SigningKey;
use proptest::prelude::*;
use std::sync::OnceLock;

fn shared_key() -> &'static SigningKey {
    static KEY: OnceLock<SigningKey> = OnceLock::new();
    KEY.get_or_init(|| SigningKey::generate().expect("gen"))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn mint_and_verify_round_trip(
        client_id in "[a-zA-Z0-9_-]{1,32}",
        scopes in prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
        ttl_seconds in 1i64..=3600,
        origin in "https://[a-z]{3,16}\\.[a-z]{2,8}",
        audience_suffix in prop::option::of("/[a-z]{2,16}"),
        patient in prop::option::of("[a-zA-Z0-9-]{1,32}"),
        is_host_owner in any::<bool>(),
    ) {
        let key = shared_key();
        let audience: Option<String> = audience_suffix.map(|s| format!("{origin}{s}"));
        let expected_aud = audience.clone().unwrap_or_else(|| origin.clone());

        let before = Utc::now();
        let token = mint_access_token(
            key,
            &NewJwtArgs {
                client_id: &client_id,
                scope: &scopes,
                ttl: Duration::seconds(ttl_seconds),
                origin: &origin,
                audience: audience.as_deref(),
                patient: patient.as_deref(),
                is_host_owner,
            },
        ).expect("mint");

        let verified_claims = verify_jwt(
            &token,
            std::slice::from_ref(key),
            &VerifyOptions {
                expected_issuer: &origin,
                accepted_audiences: std::slice::from_ref(&expected_aud),
            },
        ).expect("verify");

        // Compare the whole struct so a Debug diff names every wrong field at once.
        let expected = VerifiedClaims {
            issuer: origin.clone(),
            subject: client_id.clone(),
            audience: vec![expected_aud],
            scope: Some(scopes.join(" ")),
            patient: patient.clone(),
            // `jti` is a fresh random id we can't predict, so mirror what
            // was minted; asserted non-empty separately below. Cloned (not
            // spread) because `Option<String>` isn't `Copy` — a bare
            // `..verified_claims` would partially move it and break the
            // `&verified_claims` comparison that follows.
            jti: verified_claims.jti.clone(),
            // Spread verified_claims for timestamps through —
            // they come from `Utc::now()` so we can't predict them
            ..verified_claims
        };
        prop_assert_eq!(&verified_claims, &expected);
        // Every mint stamps a non-empty `jti` (uniqueness is covered by
        // `each_mint_carries_a_unique_jti`).
        prop_assert!(verified_claims.jti.as_deref().is_some_and(|jti| !jti.is_empty()));
        // The `wf_owner` marker round-trips: present-and-`true` only when minted.
        prop_assert_eq!(verified_claims.host_owner, is_host_owner.then_some(true));

        let iat = verified_claims.issued_at.expect("iat present");
        let exp = verified_claims.expires_at.expect("exp present");
        prop_assert_eq!(exp - iat, Duration::seconds(ttl_seconds));
        // JWT timestamps are second-precision; allow a small slack window
        // around the wall-clock `before`/`now` envelope.
        prop_assert!((iat - before).num_seconds().abs() <= 2);
    }
}

#[test]
fn verify_rejects_wrong_issuer() {
    let key = SigningKey::generate().expect("gen");
    let token = mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: "c",
            scope: &[],
            ttl: Duration::seconds(60),
            origin: "tauri://localhost",
            audience: None,
            patient: None,
            is_host_owner: false,
        },
    )
    .expect("mint");
    let err = verify_jwt(
        &token,
        &[key],
        &VerifyOptions {
            expected_issuer: "tauri://elsewhere",
            accepted_audiences: &["tauri://elsewhere".to_string()],
        },
    )
    .unwrap_err();
    assert!(matches!(err, VerifyError::TokenRejected));
}

#[test]
fn verify_rejects_empty_token() {
    let key = SigningKey::generate().expect("gen");
    let err = verify_jwt(
        "",
        &[key],
        &VerifyOptions {
            expected_issuer: "tauri://localhost",
            accepted_audiences: &["tauri://localhost".to_string()],
        },
    )
    .unwrap_err();
    assert!(matches!(err, VerifyError::TokenRejected));
}

#[test]
fn verify_rejects_when_no_keys() {
    let err = verify_jwt(
        "a.b.c",
        &[],
        &VerifyOptions {
            expected_issuer: "tauri://localhost",
            accepted_audiences: &["tauri://localhost".to_string()],
        },
    )
    .unwrap_err();
    assert!(matches!(err, VerifyError::NoSigningKeysConfigured));
}

fn owner_args<'a>(client_id: &'a str, origin: &'a str) -> NewJwtArgs<'a> {
    NewJwtArgs {
        client_id,
        scope: &[],
        ttl: Duration::seconds(60),
        origin,
        audience: None,
        patient: None,
        is_host_owner: false,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Every mint stamps a distinct `jti`: minting the *same* inputs twice
    /// must still yield two different ids (the id is random, not derived
    /// from the claims). This is the property the per-token denylist relies
    /// on — two live tokens can't collide on one revocation handle.
    #[test]
    fn each_mint_carries_a_unique_jti(
        client_id in "[a-zA-Z0-9_-]{1,32}",
        origin in "https://[a-z]{3,16}\\.[a-z]{2,8}",
        mints in 2usize..=16,
    ) {
        let key = shared_key();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..mints {
            let token = mint_access_token(key, &owner_args(&client_id, &origin)).expect("mint");
            let claims = verify_jwt(
                &token,
                std::slice::from_ref(key),
                &VerifyOptions {
                    expected_issuer: &origin,
                    accepted_audiences: std::slice::from_ref(&origin),
                },
            )
            .expect("verify");
            let jti = claims.jti.expect("minted token carries a jti");
            prop_assert!(!jti.is_empty(), "jti must be non-empty");
            prop_assert!(seen.insert(jti), "jti must be unique across mints");
        }
    }
}

/// `verify_jwt` still accepts a legacy token that carries no `jti` claim —
/// the tolerance that lets tokens minted before this change keep validating
/// (they surface `jti: None`, so the denylist just can't target them
/// individually). Encoded by hand because `mint_access_token` always writes
/// a `jti` now.
#[test]
fn verify_accepts_legacy_token_without_jti() {
    let key = SigningKey::generate().expect("gen");
    let origin = "tauri://localhost";
    let now = Utc::now();
    // A claims object with the same shape as a minted token minus `jti`.
    let legacy_claims = serde_json::json!({
        "iss": origin,
        "sub": "legacy-client",
        "aud": origin,
        "exp": (now + Duration::seconds(60)).timestamp(),
        "iat": now.timestamp(),
        "scope": "system/*.read",
    });
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(key.kid.clone());
    let enc = EncodingKey::try_from(&key).expect("encoding key");
    let token = jsonwebtoken::encode(&header, &legacy_claims, &enc).expect("encode legacy");

    let claims = verify_jwt(
        &token,
        &[key],
        &VerifyOptions {
            expected_issuer: origin,
            accepted_audiences: &[origin.to_string()],
        },
    )
    .expect("legacy no-jti token must still verify");
    assert_eq!(claims.jti, None, "a legacy token surfaces no jti");
    assert_eq!(claims.subject, "legacy-client");
}
