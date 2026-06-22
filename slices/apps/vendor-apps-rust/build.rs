//! Build-time embedder for the vendored patient-browser dist.
//!
//! Reads the gitignored upstream build at
//! `../vendor-apps/vendor/patient-browser/dist`, applies the one rewrite the
//! served app needs — rebasing root-absolute asset URLs (`/assets/`, `/img/`,
//! `/config/`) in HTML onto our `/installed-apps/patient-browser` mount — then
//! writes the files into `OUT_DIR` and emits an `ASSETS` table that
//! `include_bytes!`-es each one.
//!
//! The SMART config (`config/default.json5`) is **not** derived from upstream by
//! string-munging `config/r4.json5`. Instead a handwritten config committed at
//! `patient-browser-config/default.json5` is always embedded (and overrides any
//! `config/default.json5` shipped in the dist), so the on-device FHIR server URL
//! and timeout live in a readable, version-controlled file rather than a
//! brittle regex that panics when upstream reformats.
//!
//! When the dist is absent (a fresh clone, CI, or anyone who hasn't run the
//! upstream build) only the handwritten config is embedded and the rest of the
//! routes 404; the crate still compiles. A build script can branch on the
//! missing path where `include_str!` / `include_dir!` cannot.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Mount the served assets live under — kept byte-identical to the TS
/// generator's `MOUNT` so rebased HTML resolves to the same routes.
const MOUNT: &str = "/installed-apps/patient-browser";

/// Root-absolute prefixes rewritten in HTML to sit under [`MOUNT`].
const REBASE_PREFIXES: [&str; 3] = ["/assets/", "/img/", "/config/"];

/// Relative path (under the dist root) of the served SMART config. The
/// committed handwritten file is embedded here, overriding any dist copy.
const DEFAULT_CONFIG_REL: &str = "config/default.json5";

fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "eot" => "application/vnd.ms-fontobject",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Collect every file under `dir` (recursively) into `out`.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// Forward-slash relative path of `file` under `dist` (the asset key + the
/// `OUT_DIR` sub-path, both of which want `/` separators on every platform).
fn rel_of(dist: &Path, file: &Path) -> String {
    file.strip_prefix(dist)
        .expect("walked file is under dist")
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Rebase the three root-absolute prefixes in an HTML document onto [`MOUNT`].
fn rebase_html(text: &str) -> String {
    let mut out = text.to_owned();
    for prefix in REBASE_PREFIXES {
        out = out.replace(prefix, &format!("{MOUNT}{prefix}"));
    }
    out
}

/// One processed asset ready to embed: its content type and final bytes.
struct Processed {
    content_type: &'static str,
    bytes: Vec<u8>,
}

/// Escape a string for emission as a Rust `"..."` literal in the generated
/// table. Paths and content types are ASCII, but quoting defensively keeps the
/// generated source valid regardless of upstream filenames.
fn rust_str(value: &str) -> String {
    format!("{value:?}")
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set by cargo"),
    );
    let out_dir =
        PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR set by cargo for build scripts"));
    let dist = manifest_dir.join("../vendor-apps/vendor/patient-browser/dist");
    let config_path = manifest_dir.join("patient-browser-config/default.json5");

    // Cargo re-runs the build script when these paths' listings/contents change.
    // The dist line is printed even when the directory is absent so populating
    // it later triggers a rebuild.
    println!("cargo:rerun-if-changed={}", dist.display());
    println!("cargo:rerun-if-changed={}", config_path.display());

    // BTreeMap both de-dupes and sorts by path so the generated table is stable
    // across runs (and platforms with differing readdir order).
    let mut processed: BTreeMap<String, Processed> = BTreeMap::new();

    // Always embed the handwritten SMART config — committed, so it survives dist
    // regens and is served even on a checkout without the vendored build.
    let config_bytes = std::fs::read(&config_path).unwrap_or_else(|error| {
        panic!(
            "vendor-apps-rust: handwritten config {} could not be read ({error})",
            config_path.display(),
        )
    });
    processed.insert(
        DEFAULT_CONFIG_REL.to_owned(),
        Processed {
            content_type: "application/json; charset=utf-8",
            bytes: config_bytes,
        },
    );

    if dist.exists() {
        let mut files = Vec::new();
        walk(&dist, &mut files);
        for file in &files {
            println!("cargo:rerun-if-changed={}", file.display());
            let rel = rel_of(&dist, file);
            let ext = file
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();

            // Source maps bloat the binary and are never requested by the
            // running SPA; the handwritten config overrides any dist copy.
            if ext == "map" || rel == DEFAULT_CONFIG_REL {
                continue;
            }

            let raw = std::fs::read(file).expect("read dist asset");
            let bytes = if ext == "html" {
                rebase_html(&String::from_utf8_lossy(&raw)).into_bytes()
            } else {
                raw
            };
            processed.insert(
                rel,
                Processed {
                    content_type: content_type_for(&ext),
                    bytes,
                },
            );
        }
    }

    // Write each processed asset into OUT_DIR and build the embed table.
    let mut table = String::from(
        "// Generated by vendor-apps-rust/build.rs — do not edit.\n\
         pub static ASSETS: &[Asset] = &[\n",
    );
    for (rel, asset) in &processed {
        let dest = out_dir.join("processed").join(rel);
        std::fs::create_dir_all(dest.parent().expect("asset has a parent dir"))
            .expect("create OUT_DIR asset parent");
        std::fs::write(&dest, &asset.bytes).expect("write processed asset into OUT_DIR");
        let include_path = format!("{}/processed/{rel}", out_dir.display());
        table.push_str(&format!(
            "    Asset {{ path: {}, content_type: {}, bytes: include_bytes!({}) }},\n",
            rust_str(rel),
            rust_str(asset.content_type),
            rust_str(&include_path),
        ));
    }
    table.push_str("];\n");

    std::fs::write(out_dir.join("assets.rs"), table).expect("write generated assets.rs");
}
