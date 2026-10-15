use std::path::Path;

/// The host's compile-time config, shared with `src/main.tsx`. See
/// `tauri-shared-config.json` for the contract.
#[derive(serde::Deserialize)]
struct TauriSharedConfig {
    host_app_client_scopes: String,
    wildflower_host_app_client_id: String,
    launcher_base_url: String,
    authorization_app_base_url: String,
    background_service_label: String,
    background_service_foreground_type: String,
}

/// The one key of `dev-app-ports.json` the host reads: the port the
/// launcher's dev server binds, which a debug build links its launcher pages to.
#[derive(serde::Deserialize)]
struct DevAppPorts {
    #[serde(rename = "launcher-dev")]
    launcher_dev: u16,
}

fn main() {
    // SINGLE SOURCE OF TRUTH: `apps/host/host-app/tauri-shared-config.json`.
    // Reading it here and re-emitting the values as compile-time env vars keeps
    // the Rust runtime config from drifting from it: `src/lib.rs` reads them
    // via `env!`.
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
        "cargo:rustc-env=WILDFLOWER_HOST_APP_CLIENT_SCOPES={}",
        config.host_app_client_scopes
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_HOST_APP_CLIENT_ID={}",
        config.wildflower_host_app_client_id
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_LAUNCHER_BASE_URL={}",
        config.launcher_base_url
    );
    println!(
        "cargo:rustc-env=WILDFLOWER_AUTHORIZATION_APP_BASE_URL={}",
        config.authorization_app_base_url
    );
    // The debug launcher address is the launcher's dev server, whose port the
    // shared dev-port file pins (the launcher's `vite.config.web.ts` binds it).
    let dev_ports_path = Path::new(&manifest_dir).join("../../../../dev-app-ports.json");
    println!("cargo:rerun-if-changed={}", dev_ports_path.display());
    let dev_ports_raw = std::fs::read_to_string(&dev_ports_path).unwrap_or_else(|error| {
        panic!(
            "failed to read dev app ports at {}: {error}",
            dev_ports_path.display()
        )
    });
    let dev_ports: DevAppPorts = serde_json::from_str(&dev_ports_raw).unwrap_or_else(|error| {
        panic!(
            "failed to parse dev app ports at {}: {error}",
            dev_ports_path.display()
        )
    });
    println!(
        "cargo:rustc-env=WILDFLOWER_LAUNCHER_DEV_BASE_URL=http://localhost:{}/",
        dev_ports.launcher_dev
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
