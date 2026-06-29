use url::Url;

#[derive(Debug, Clone)]
pub struct ServerRuntimeConfig {
    pub loopback_base_url: Url,
    pub app_data_dir: std::path::PathBuf,
}

impl ServerRuntimeConfig {
    /// The `host:port` authority the embedded API server binds to, e.g.
    /// `127.0.0.1:8080`. Parses as a [`std::net::SocketAddr`] when the
    /// hostname is an IP.
    pub fn loopback_authority(&self) -> String {
        self.loopback_base_url.authority().to_string()
    }

    /// The HTTP-only loopback origin the embedded API server is reached at, e.g.
    /// `http://127.0.0.1:8080/`, as a typed [`Url`]. Single source of truth the
    /// host threads into every slice's config (apps / gatekeeper / emr / tunnel)
    /// — keeping the scheme/host/port assembly in one place and parsed once, so
    /// no downstream rebuilds it from a string. Consumers that need the bare
    /// origin string take `loopback_origin().origin().ascii_serialization()`.
    ///
    /// # Panics
    ///
    /// Panics if the configured hostname/port don't form a valid `http://` URL.
    /// The values come from build-time config (`tauri-shared-config.json`), so a
    /// malformed one is a build error surfaced at first boot, not a runtime path.
    #[must_use]
    pub fn loopback_origin(&self) -> Url {
        self.loopback_base_url.clone()
    }
}
