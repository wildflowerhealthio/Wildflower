#[derive(Debug, Clone)]
pub struct ServerRuntimeConfig {
    pub loopback_hostname: String,
    pub loopback_port: u16,
    pub app_data_dir: std::path::PathBuf,
}

impl ServerRuntimeConfig {
    /// The `host:port` authority the embedded API server binds to, e.g.
    /// `127.0.0.1:8080`. Parses as a [`std::net::SocketAddr`] when the
    /// hostname is an IP.
    pub fn loopback_authority(&self) -> String {
        format!("{}:{}", self.loopback_hostname, self.loopback_port)
    }

    /// The HTTP-only loopback origin the embedded API server is reached at,
    /// e.g. `http://127.0.0.1:8080`. Single source of truth for the string
    /// that emr-rust, gatekeeper, and the Tauri host all otherwise rebuild
    /// by hand — keeping the scheme/host/port assembly in one place.
    pub fn loopback_origin(&self) -> String {
        format!("http://{}", self.loopback_authority())
    }
}
