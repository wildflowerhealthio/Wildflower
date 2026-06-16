use std::path::Path;

/// Embedded loopback config, shared verbatim with the TS shell. See
/// `tauri-shared-config.json` for the contract.
#[derive(serde::Deserialize)]
struct TauriSharedConfig {
    loopback_hostname: String,
    loopback_port: u16,
}

fn main() {
    // SINGLE SOURCE OF TRUTH: `apps/wildflower-tauri/tauri-shared-config.json`
    // pins the loopback hostname/port the embedded API server binds to. The TS
    // shell derives its `apiBaseUrl` from the same file (`vite.config.ts` ->
    // `WILDFLOWER_LOOPBACK_ORIGIN`). Reading it here and re-emitting the values
    // as compile-time env vars keeps the Rust runtime config from drifting:
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

    // Build-time tunnel seed: read the package-local `.env` (a sibling of this
    // build script), NOT dotenvy's ancestor-walking `dotenv()` — which, with no
    // sibling `.env`, resolves the repo-root `.env` and would bake unrelated
    // secrets (e.g. a `GH_TOKEN`) into the distributed binary. Forward only the
    // documented WILDFLOWER_TUNNEL_* keys, so an unrelated key in the file is
    // never compiled in.
    const TUNNEL_SEED_KEYS: [&str; 5] = [
        "WILDFLOWER_TUNNEL_PUBLIC_HOST",
        "WILDFLOWER_TUNNEL_RELAY_REMOTE_ADDR",
        "WILDFLOWER_TUNNEL_RELAY_TOKEN",
        "WILDFLOWER_TUNNEL_RELAY_PUBLIC_KEY",
        "WILDFLOWER_TUNNEL_RELAY_SERVICE_NAME",
    ];
    let env_path = Path::new(&manifest_dir).join(".env");

    // Re-run when the .env appears or changes (registered even when absent, so a
    // later `cp .env.example .env` triggers a rebuild) and when any seed key is
    // overridden via the shell environment. Emitting any rerun-if-* directive
    // opts this script out of cargo's default "rerun on any package-file change".
    println!("cargo:rerun-if-changed={}", env_path.display());
    for key in TUNNEL_SEED_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    if env_path.exists() {
        for item in dotenvy::from_path_iter(&env_path)
            .expect("pinned .env to be loadable")
            .flatten()
        {
            let (key, value) = item;
            if TUNNEL_SEED_KEYS.contains(&key.as_str()) {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }

    tauri_build::build();
}
