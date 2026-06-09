use thiserror::Error;

#[derive(Debug, Error)]
pub enum MintError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("no signing keys in store")]
    NoSigningKeys,
    #[error("jwt sign: {0}")]
    JwtSign(String),
}
