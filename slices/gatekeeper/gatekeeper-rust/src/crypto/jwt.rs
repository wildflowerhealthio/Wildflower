use jsonwebtoken::{Algorithm, DecodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use super::signing_key::{decoding_key, encoding_key, SigningKey};
use crate::time;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub exp: i64,
    pub iat: i64,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patient: Option<String>,
}

pub struct MintArgs<'a> {
    pub client_id: &'a str,
    pub scope: &'a [String],
    pub ttl_secs: i64,
    pub origin: &'a str,
    pub audience: Option<&'a str>,
    pub patient: Option<&'a str>,
}

#[derive(Debug, thiserror::Error)]
pub enum MintError {
    #[error("key material: {0}")]
    KeyMaterial(String),
    #[error("jwt encode: {0}")]
    Encode(#[from] jsonwebtoken::errors::Error),
}

pub fn mint_access_token(
    signing_key: &SigningKey,
    args: MintArgs<'_>,
) -> Result<String, MintError> {
    let now = time::now();
    let exp = time::add_seconds(now, args.ttl_secs);
    let claims = AccessTokenClaims {
        iss: args.origin.to_string(),
        sub: args.client_id.to_string(),
        aud: args.audience.unwrap_or(args.origin).to_string(),
        exp: time::to_epoch_seconds(exp),
        iat: time::to_epoch_seconds(now),
        scope: args.scope.join(" "),
        patient: args.patient.map(str::to_string),
    };
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(signing_key.kid.clone());
    let enc = encoding_key(signing_key).map_err(|e| MintError::KeyMaterial(e.to_string()))?;
    Ok(jsonwebtoken::encode(&header, &claims, &enc)?)
}

#[derive(Debug, Clone, Deserialize)]
pub struct VerifiedClaims {
    pub iss: String,
    pub sub: String,
    pub aud: serde_json::Value,
    pub exp: Option<i64>,
    pub iat: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub patient: Option<String>,
}

pub struct VerifyOptions<'a> {
    pub expected_issuer: &'a str,
    pub accepted_audiences: &'a [String],
}

#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("server error: no signing keys")]
    NoSigningKeys,
    #[error("server error: key material")]
    KeyMaterial,
}

pub fn verify_jwt(
    token: &str,
    keys: &[SigningKey],
    opts: VerifyOptions<'_>,
) -> Result<VerifiedClaims, VerifyError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(VerifyError::Unauthorized);
    }
    if keys.is_empty() {
        return Err(VerifyError::NoSigningKeys);
    }
    let header = jsonwebtoken::decode_header(token).map_err(|_| VerifyError::Unauthorized)?;
    let candidates: Vec<&SigningKey> = match &header.kid {
        Some(kid) => {
            let matched: Vec<&SigningKey> = keys.iter().filter(|k| &k.kid == kid).collect();
            if matched.is_empty() {
                keys.iter().collect()
            } else {
                matched
            }
        }
        None => keys.iter().collect(),
    };
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[opts.expected_issuer]);
    let audiences: Vec<&str> = opts.accepted_audiences.iter().map(String::as_str).collect();
    validation.set_audience(&audiences);
    validation.validate_exp = true;
    for key in candidates {
        let dec: DecodingKey = match decoding_key(key) {
            Ok(d) => d,
            Err(_) => return Err(VerifyError::KeyMaterial),
        };
        if let Ok(decoded) =
            jsonwebtoken::decode::<VerifiedClaims>(token, &dec, &validation)
        {
            return Ok(decoded.claims);
        }
    }
    Err(VerifyError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::signing_key::generate;

    #[test]
    fn mint_and_verify_round_trip() {
        let key = generate().expect("gen");
        let token = mint_access_token(
            &key,
            MintArgs {
                client_id: "wildflower-host",
                scope: &["owner".to_string()],
                ttl_secs: 60,
                origin: "tauri://localhost",
                audience: Some("tauri://localhost/fhir-r4"),
                patient: None,
            },
        )
        .expect("mint");
        let claims = verify_jwt(
            &token,
            &[key.clone()],
            VerifyOptions {
                expected_issuer: "tauri://localhost",
                accepted_audiences: &["tauri://localhost/fhir-r4".to_string()],
            },
        )
        .expect("verify");
        assert_eq!(claims.iss, "tauri://localhost");
        assert_eq!(claims.sub, "wildflower-host");
        assert_eq!(claims.scope.as_deref(), Some("owner"));
    }

    #[test]
    fn verify_rejects_wrong_issuer() {
        let key = generate().expect("gen");
        let token = mint_access_token(
            &key,
            MintArgs {
                client_id: "c",
                scope: &[],
                ttl_secs: 60,
                origin: "tauri://localhost",
                audience: None,
                patient: None,
            },
        )
        .expect("mint");
        let err = verify_jwt(
            &token,
            &[key],
            VerifyOptions {
                expected_issuer: "tauri://elsewhere",
                accepted_audiences: &["tauri://elsewhere".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, VerifyError::Unauthorized));
    }

    #[test]
    fn verify_rejects_empty_token() {
        let key = generate().expect("gen");
        let err = verify_jwt(
            "",
            &[key],
            VerifyOptions {
                expected_issuer: "tauri://localhost",
                accepted_audiences: &["tauri://localhost".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, VerifyError::Unauthorized));
    }

    #[test]
    fn verify_rejects_when_no_keys() {
        let err = verify_jwt(
            "a.b.c",
            &[],
            VerifyOptions {
                expected_issuer: "tauri://localhost",
                accepted_audiences: &["tauri://localhost".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, VerifyError::NoSigningKeys));
    }
}
