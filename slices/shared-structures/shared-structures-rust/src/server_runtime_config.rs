#[derive(Debug, Clone)]
pub struct ServerRuntimeConfig {
    pub loopback_hostname: String,
    pub loopback_port: u16,
    pub app_data_dir: std::path::PathBuf,
}
