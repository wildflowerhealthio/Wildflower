#[derive(Debug, Clone)]
pub struct ServerRuntimeConfig {
    pub host: String,
    pub port: u16,
    pub app_data_dir: std::path::PathBuf,
}
