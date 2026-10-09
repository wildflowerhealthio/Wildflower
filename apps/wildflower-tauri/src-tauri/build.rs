use std::path::Path;

/// The host's compile-time config, shared with `src/main.tsx`. See
/// `tauri-shared-config.json` for the contract.
#[derive(serde::Deserialize)]
struct TauriSharedConfig {
    loopback_hostname: String,
    loopback_port: u16,
    local_granted_scopes: String,
    first_party_client_id: String,
    owner_ui_base_url: String,
    owner_ui_dev_base_url: String,
    background_service_label: String,
    background_service_foreground_type: String,
}

fn main() {
    // SINGLE SOURCE OF TRUTH: `apps/wildflower-tauri/tauri-shared-config.json`
    // pins the loopback hostname/port the embedded API server binds to.
    // Reading it here and re-emitting the values as compile-time env vars keeps
    // the Rust runtime config from drifting from it:
    // `src/lib.rs` reads
    // `WILDFLOWER_LOOPBACK_HOSTNAME`/`WILDFLOWER_LOOPBACK_PORT` via `env!`, so a
    // value that doesn't parse fails the build rather than shipping a mismatch.
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is always set by cargo");
    let shared_config_path = Path::new(&manifest_dir).join("../tauri-shared-config.json");

    println!("cargo:rerun-if-changed={}", shared_config_path.display());

    let raw = std::fs::read_to_string(&shared_config_path).unwrap_or_else(|error| {
        panic!(
            "failed to read shared tauri config at {}: {error}",
            shared_config_path.display()
        )
    });
    let config: TauriSharedConfig = serde_json::from_str(&raw).unwrap_or_else(|error| {
        panic!(
            "failed to parse shared tauri config at {}: {error}",
            shared_config_path.display()
        )
    });

    println!(
        "cargo:rustc-env=WILDFLOWER_LOOPBACK_HOSTNAME={}",
        config.loopback_hostname
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_LOOPBACK_PORT={}",
        config.loopback_port
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_LOCAL_GRANTED_SCOPES={}",
        config.local_granted_scopes
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_FIRST_PARTY_CLIENT_ID={}",
        config.first_party_client_id
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_OWNER_UI_BASE_URL={}",
        config.owner_ui_base_url
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_OWNER_UI_DEV_BASE_URL={}",
        config.owner_ui_dev_base_url
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_BACKGROUND_SERVICE_LABEL={}",
        config.background_service_label
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_BACKGROUND_SERVICE_FOREGROUND_TYPE={}",
        config.background_service_foreground_type
    );

    tauri_build::build();
}
