#[derive(Debug, Clone)]
pub struct ServerRuntimeConfig {
    /// The folder this server runs from, `<data root>/servers/<domain>/`: its
    /// databases live here and nowhere else, beside its certificates. Install-wide
    /// files (the server registry, saved recordings) stay in the data root
    /// above it, which the server never sees, but for the ACME account folder
    /// the host hands it.
    pub server_dir: std::path::PathBuf,
}
