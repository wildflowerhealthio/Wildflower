use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct GatekeeperConfig {
    pub db_file_path: PathBuf,
}
