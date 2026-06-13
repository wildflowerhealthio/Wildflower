use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{DecodingKey, EncodingKey};
use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::traits::PrivateKeyParts;
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::crypto_util::public_jwk::PublicJwk;

/// The base64url-encoded RSA key components stored in the `values_json` column of a `signing_keys` row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SigningKeyValues {
    /// The modulus `n` of the RSA key, base64url-encoded.
    pub n: String,
    /// The private exponent `d` of the RSA key, base64url-encoded.
    pub d: String,
    /// The public exponent `e` of the RSA key, base64url-encoded.
    pub e: String,
    /// The first prime factor `p` of the RSA modulus, base64url-encoded.
    pub p: String,
    /// The second prime factor `q` of the RSA modulus, base64url-encoded.
    pub q: String,
}

/// An RSA signing key used to mint and verify access tokens; `is_active` distinguishes the current minter from rotated-out verify-only keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningKey {
    /// Unique key identifier emitted in the JWS `kid` header so verifiers can pick the right key.
    pub kid: String,
    /// JWK key type — always `"RSA"` for keys produced here.
    pub kty: String,
    /// JWS signing algorithm — always `"RS256"` for keys produced here.
    pub alg: String,
    /// RSA key components: public (`n`, `e`) and private (`d`, `p`, `q`).
    pub values: SigningKeyValues,
    /// Whether this key currently signs new tokens; retired keys stay published in the JWKS during rotation.
    pub is_active: bool,
}

impl SigningKey {
    /// Generate a fresh 2048-bit RSA `SigningKey` with a new random `kid` (inactive by default).
    ///
    /// # Errors
    ///
    /// Returns [`KeyMaterialError::Generate`] if RSA key generation fails.
    pub fn generate() -> Result<SigningKey, KeyMaterialError> {
        let mut rng = rand::thread_rng();
        let private = RsaPrivateKey::new(&mut rng, 2048).map_err(KeyMaterialError::Generate)?;
        Ok(SigningKey::from(&private))
    }
}

/// Wrap an existing `RsaPrivateKey` as a `SigningKey` with base64url-encoded JWK components and a new `kid`.
impl From<&RsaPrivateKey> for SigningKey {
    fn from(private: &RsaPrivateKey) -> Self {
        let primes = private.primes();
        let p = &primes[0];
        let q = &primes[1];
        SigningKey {
            kid: Uuid::new_v4().to_string(),
            kty: "RSA".to_string(),
            alg: "RS256".to_string(),
            values: SigningKeyValues {
                n: crate::crypto_util::base64url(&private.n().to_bytes_be()),
                e: crate::crypto_util::base64url(&private.e().to_bytes_be()),
                d: crate::crypto_util::base64url(&private.d().to_bytes_be()),
                p: crate::crypto_util::base64url(&p.to_bytes_be()),
                q: crate::crypto_util::base64url(&q.to_bytes_be()),
            },
            is_active: false,
        }
    }
}

/// Public-only JWK view of `key`, suitable for publishing in a JWKS endpoint.
impl From<&SigningKey> for PublicJwk {
    fn from(key: &SigningKey) -> Self {
        PublicJwk {
            kid: key.kid.clone(),
            kty: key.kty.clone(),
            alg: key.alg.clone(),
            key_ops: vec!["verify".to_string()],
            n: key.values.n.clone(),
            e: key.values.e.clone(),
        }
    }
}

/// Build a `jsonwebtoken::EncodingKey` (for signing JWTs) from a `SigningKey`.
impl TryFrom<&SigningKey> for EncodingKey {
    type Error = KeyMaterialError;

    fn try_from(key: &SigningKey) -> Result<Self, Self::Error> {
        let private = RsaPrivateKey::try_from(key)?;
        let der = private.to_pkcs1_der().map_err(KeyMaterialError::Encode)?;
        Ok(EncodingKey::from_rsa_der(der.as_bytes()))
    }
}

/// Build a `jsonwebtoken::DecodingKey` (for verifying JWTs) from a `SigningKey`.
impl TryFrom<&SigningKey> for DecodingKey {
    type Error = KeyMaterialError;

    fn try_from(key: &SigningKey) -> Result<Self, Self::Error> {
        let public = RsaPublicKey::try_from(key)?;
        let der = public.to_pkcs1_der().map_err(KeyMaterialError::Encode)?;
        Ok(DecodingKey::from_rsa_der(der.as_bytes()))
    }
}

/// Reconstruct an `RsaPrivateKey` from a `SigningKey`'s base64url JWK components.
impl TryFrom<&SigningKey> for RsaPrivateKey {
    type Error = KeyMaterialError;

    #[allow(clippy::many_single_char_names)]
    fn try_from(key: &SigningKey) -> Result<Self, Self::Error> {
        let n = base64_url_to_biguint(&key.values.n)?;
        let e = base64_url_to_biguint(&key.values.e)?;
        let d = base64_url_to_biguint(&key.values.d)?;
        let p = base64_url_to_biguint(&key.values.p)?;
        let q = base64_url_to_biguint(&key.values.q)?;
        RsaPrivateKey::from_components(n, e, d, vec![p, q]).map_err(KeyMaterialError::Compose)
    }
}

/// Reconstruct an `RsaPublicKey` from a `SigningKey`'s public JWK components (`n`, `e`).
impl TryFrom<&SigningKey> for RsaPublicKey {
    type Error = KeyMaterialError;

    fn try_from(key: &SigningKey) -> Result<Self, Self::Error> {
        let n = base64_url_to_biguint(&key.values.n)?;
        let e = base64_url_to_biguint(&key.values.e)?;
        RsaPublicKey::new(n, e).map_err(KeyMaterialError::Compose)
    }
}

/// Decode a base64url JWK component into a big-endian `BigUint`.
fn base64_url_to_biguint(s: &str) -> Result<BigUint, KeyMaterialError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(KeyMaterialError::Decode)?;
    Ok(BigUint::from_bytes_be(&bytes))
}

/// Failure modes when round-tripping a `SigningKey` through `jsonwebtoken`/`rsa` — bad JWK components, DER encode, RSA composition, or fresh-key generation.
///
/// Each variant keeps the original source error (`#[source]`) so the full
/// cause chain survives for logging rather than being flattened to a string.
/// `Compose` and `Generate` both wrap `rsa::Error`, so neither uses `#[from]`
/// (two `From<rsa::Error>` impls would conflict) — call sites construct them
/// explicitly to keep the two failure modes distinct.
#[derive(Debug, thiserror::Error)]
pub enum KeyMaterialError {
    #[error("decode JWK component")]
    Decode(#[source] base64::DecodeError),
    #[error("compose RSA key")]
    Compose(#[source] rsa::Error),
    #[error("encode Distinguished Encoding Rules (DER)")]
    Encode(#[source] rsa::pkcs1::Error),
    #[error("generate RSA key")]
    Generate(#[source] rsa::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_sign_verify() {
        use jsonwebtoken::{Algorithm, Header, Validation};
        let key = SigningKey::generate().expect("generate");
        let enc = EncodingKey::try_from(&key).expect("enc");
        let dec = DecodingKey::try_from(&key).expect("dec");
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(key.kid.clone());
        let claims = serde_json::json!({ "sub": "alice", "exp": 9_999_999_999u64 });
        let token = jsonwebtoken::encode(&header, &claims, &enc).expect("encode");
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_aud = false;
        let decoded =
            jsonwebtoken::decode::<serde_json::Value>(&token, &dec, &validation).expect("decode");
        // Assert the whole round trip in one line so every claim is checked,
        // not just `sub`.
        assert_eq!(decoded.claims, claims);
    }
}
