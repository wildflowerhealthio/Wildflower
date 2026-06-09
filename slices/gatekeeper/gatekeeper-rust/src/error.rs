use thiserror::Error;

#[derive(Debug, Error)]
pub enum SetupError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("rsa keygen: {0}")]
    RsaKeygen(#[from] rsa::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Error)]
pub enum MintError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("no signing keys in store")]
    NoSigningKeys,
    #[error("jwt sign: {0}")]
    JwtSign(String),
}
