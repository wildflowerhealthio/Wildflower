use thiserror::Error;

/// Failures while minting the host owner token at boot.
#[derive(Debug, Error)]
pub enum HostTokenError {
    /// Reading signing keys from the store failed.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// No signing keys are present in the store — bootstrap has not run, or
    /// the database has been tampered with.
    #[error("no signing keys in store")]
    NoSigningKeys,
    /// `crypto::jwt` failed to sign the token; the wrapped error preserves
    /// whether it was a key-material or encoding failure.
    #[error("jws sign: {0}")]
    JwsSignFailed(#[from] crate::domain::token::MintError),
}
