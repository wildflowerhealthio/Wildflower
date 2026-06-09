use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{DecodingKey, EncodingKey};
use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::traits::PrivateKeyParts;
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SigningKeyValues {
    pub d: String,
    pub e: String,
    pub n: String,
    pub p: String,
    pub q: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SigningKey {
    pub kid: String,
    pub kty: String,
    pub alg: String,
    pub values: SigningKeyValues,
}

#[derive(Debug, Serialize)]
pub struct PublicJwk {
    pub kid: String,
    pub kty: String,
    pub alg: String,
    pub key_ops: Vec<String>,
    pub n: String,
    pub e: String,
}

pub fn public_jwk(key: &SigningKey) -> PublicJwk {
    PublicJwk {
        kid: key.kid.clone(),
        kty: key.kty.clone(),
        alg: key.alg.clone(),
        key_ops: vec!["verify".to_string()],
        n: key.values.n.clone(),
        e: key.values.e.clone(),
    }
}

pub fn generate() -> Result<SigningKey, rsa::Error> {
    let mut rng = rand::thread_rng();
    let private = RsaPrivateKey::new(&mut rng, 2048)?;
    Ok(from_rsa_private(&private))
}

pub fn from_rsa_private(private: &RsaPrivateKey) -> SigningKey {
    let primes = private.primes();
    let p = &primes[0];
    let q = &primes[1];
    SigningKey {
        kid: Uuid::new_v4().to_string(),
        kty: "RSA".to_string(),
        alg: "RS256".to_string(),
        values: SigningKeyValues {
            n: b64u(&private.n().to_bytes_be()),
            e: b64u(&private.e().to_bytes_be()),
            d: b64u(&private.d().to_bytes_be()),
            p: b64u(&p.to_bytes_be()),
            q: b64u(&q.to_bytes_be()),
        },
    }
}

pub fn encoding_key(key: &SigningKey) -> Result<EncodingKey, KeyMaterialError> {
    let private = rsa_private_key(key)?;
    let der = private
        .to_pkcs1_der()
        .map_err(|e| KeyMaterialError::Encode(e.to_string()))?;
    Ok(EncodingKey::from_rsa_der(der.as_bytes()))
}

pub fn decoding_key(key: &SigningKey) -> Result<DecodingKey, KeyMaterialError> {
    let public = rsa_public_key(key)?;
    let der = public
        .to_pkcs1_der()
        .map_err(|e| KeyMaterialError::Encode(e.to_string()))?;
    Ok(DecodingKey::from_rsa_der(der.as_bytes()))
}

fn rsa_private_key(key: &SigningKey) -> Result<RsaPrivateKey, KeyMaterialError> {
    let n = b64u_decode_biguint(&key.values.n)?;
    let e = b64u_decode_biguint(&key.values.e)?;
    let d = b64u_decode_biguint(&key.values.d)?;
    let p = b64u_decode_biguint(&key.values.p)?;
    let q = b64u_decode_biguint(&key.values.q)?;
    RsaPrivateKey::from_components(n, e, d, vec![p, q])
        .map_err(|e| KeyMaterialError::Compose(e.to_string()))
}

fn rsa_public_key(key: &SigningKey) -> Result<RsaPublicKey, KeyMaterialError> {
    let n = b64u_decode_biguint(&key.values.n)?;
    let e = b64u_decode_biguint(&key.values.e)?;
    RsaPublicKey::new(n, e).map_err(|e| KeyMaterialError::Compose(e.to_string()))
}

fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn b64u_decode_biguint(s: &str) -> Result<BigUint, KeyMaterialError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| KeyMaterialError::Decode(e.to_string()))?;
    Ok(BigUint::from_bytes_be(&bytes))
}

#[derive(Debug, thiserror::Error)]
pub enum KeyMaterialError {
    #[error("decode JWK component: {0}")]
    Decode(String),
    #[error("compose RSA key: {0}")]
    Compose(String),
    #[error("encode DER: {0}")]
    Encode(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_sign_verify() {
        use jsonwebtoken::{Algorithm, Header, Validation};
        let key = generate().expect("generate");
        let enc = encoding_key(&key).expect("enc");
        let dec = decoding_key(&key).expect("dec");
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(key.kid.clone());
        let claims = serde_json::json!({ "sub": "alice", "exp": 9_999_999_999u64 });
        let token = jsonwebtoken::encode(&header, &claims, &enc).expect("encode");
        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_aud = false;
        let decoded =
            jsonwebtoken::decode::<serde_json::Value>(&token, &dec, &validation).expect("decode");
        assert_eq!(decoded.claims["sub"], "alice");
    }
}
