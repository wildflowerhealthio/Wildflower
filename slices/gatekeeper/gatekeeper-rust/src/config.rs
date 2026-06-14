use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct GatekeeperConfig {
    pub db_file_path: PathBuf,
    /// The HTTP-only loopback origin the embedded API server binds to, e.g.
    /// `http://127.0.0.1:8080`. Always loopback: the boot-time host owner
    /// token is minted against it, and it is the fallback
    /// [`served_origin_for`](crate::http::served_origin_for) returns when a
    /// request carries no public-origin header.
    pub loopback_origin: String,
}
