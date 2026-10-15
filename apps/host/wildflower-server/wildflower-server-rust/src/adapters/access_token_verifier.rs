//! The host's [`wildflowerhealthio_fhir_r4::AccessTokenVerifier`], backed by
//! the authorization server's own token verifier.

use wildflowerhealthio_authorization_server::domain::token::VerifyError;
use wildflowerhealthio_fhir_r4::{
    AccessTokenVerifier, AccessTokenVerifyError, VerifiedAccessToken,
};

/// The host's [`AccessTokenVerifier`]: verifies each bearer HFS is handed
/// through the authorization server's
/// [`wildflowerhealthio_authorization_server::InProcessTokenVerifier`], the
/// policy its own gates run, so HFS admits exactly the tokens they do.
pub(crate) struct AuthorizationServerAccessTokenVerifier {
    pub(crate) verifier: wildflowerhealthio_authorization_server::InProcessTokenVerifier,
}

impl AccessTokenVerifier for AuthorizationServerAccessTokenVerifier {
    fn verify(&self, token: &str) -> Result<VerifiedAccessToken, AccessTokenVerifyError> {
        let claims = self.verifier.verify(token).map_err(|error| match error {
            VerifyError::TokenRejected | VerifyError::Revoked => {
                AccessTokenVerifyError::Rejected(error.to_string())
            }
            VerifyError::NoSigningKeysConfigured
            | VerifyError::KeyStoreUnavailable(_)
            | VerifyError::SigningKeyUnreadable(_)
            | VerifyError::RevocationStoreUnavailable(_) => {
                AccessTokenVerifyError::VerifierFailed(format!("{:#}", anyhow::Error::from(error)))
            }
        })?;
        // The verifier requires `exp`, so a verified token always has one.
        let expires_at = claims.expires_at.ok_or_else(|| {
            AccessTokenVerifyError::Rejected("token carries no expiry".to_owned())
        })?;
        Ok(VerifiedAccessToken {
            subject: claims.subject,
            issuer: claims.issuer,
            jti: claims.jti,
            expires_at,
            scope: claims.scope,
        })
    }
}
