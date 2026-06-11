use std::path::Path;

/// Embedded API origin, shared verbatim with the TS shell. See
/// `api-origin.json` for the contract.
#[derive(serde::Deserialize)]
struct ApiOrigin {
    host: String,
    port: u16,
}

fn main() {
    // SINGLE SOURCE OF TRUTH: `apps/wildflower-tauri/api-origin.json` pins
    // the loopback host/port the embedded API server binds to. The TS shell
    // derives its `apiBaseUrl` from the same file (`vite.config.ts` ->
    // `__API_ORIGIN__`). Reading it here and re-emitting the values as
    // compile-time env vars keeps the Rust runtime config from drifting:
    // `src/lib.rs` reads `WILDFLOWER_API_HOST`/`WILDFLOWER_API_PORT` via
    // `env!`, so a value that doesn't parse fails the build rather than
    // shipping a mismatch.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR is always set by cargo");
    let origin_path = Path::new(&manifest_dir).join("../api-origin.json");

    println!("cargo:rerun-if-changed={}", origin_path.display());

    let raw = std::fs::read_to_string(&origin_path).unwrap_or_else(|error| {
        panic!(
            "failed to read shared API origin at {}: {error}",
            origin_path.display()
        )
    });
    let origin: ApiOrigin = serde_json::from_str(&raw).unwrap_or_else(|error| {
        panic!(
            "failed to parse shared API origin at {}: {error}",
            origin_path.display()
        )
    });

    println!("cargo:rustc-env=WILDFLOWER_API_HOST={}", origin.host);
    println!("cargo:rustc-env=WILDFLOWER_API_PORT={}", origin.port);

    tauri_build::build()
}
