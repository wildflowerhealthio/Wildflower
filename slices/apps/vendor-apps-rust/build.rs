//! Build-time embedder for the vendored patient-browser dist.
//!
//! Reads the gitignored upstream build at
//! `../vendor-apps/vendor/patient-browser/dist`, applies the same two rewrites
//! the TS generator (`vendor-apps/scripts/generate-patient-browser.mjs`) does —
//!
//!   1. rebase root-absolute asset URLs (`/assets/`, `/img/`, `/config/`) in
//!      HTML onto our `/installed-apps/patient-browser` mount, and
//!   2. synthesize `config/default.json5` from upstream's `config/r4.json5`,
//!      pointing the SMART config at the on-device `/fhir-r4` server with a long
//!      request timeout
//!
//! — then writes the processed files into `OUT_DIR` and emits an `ASSETS` table
//! that `include_bytes!`-es each one. When the dist is absent (a fresh clone,
//! CI, or anyone who hasn't run the upstream build) the table is empty and the
//! crate still compiles; the patient-browser routes 404 until the dist is
//! populated and the crate rebuilt. This mirrors the sniffer-bootstrap pattern
//! (gitignored generated artifact) but degrades to empty on its own rather than
//! needing a CI stub, because a build script can branch on the missing path
//! where `include_str!` / `include_dir!` cannot.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Mount the served assets live under — kept byte-identical to the TS
/// generator's `MOUNT` so rebased HTML resolves to the same routes.
const MOUNT: &str = "/installed-apps/patient-browser";

/// Root-absolute prefixes rewritten in HTML to sit under [`MOUNT`].
const REBASE_PREFIXES: [&str; 3] = ["/assets/", "/img/", "/config/"];

/// Upstream → on-device SMART config rewrites, byte-identical to the TS
/// generator's replacements. The upstream `config/r4.json5` is the source for
/// the served `config/default.json5`.
const UPSTREAM_FHIR_URL: &str = "\"https://r4.smarthealthit.org\"";
const ONDEVICE_FHIR_URL: &str = "\"/fhir-r4\"";
const UPSTREAM_TIMEOUT: &str = "timeout: 20000";
const ONDEVICE_TIMEOUT: &str = "timeout: 600000";

/// Relative path (under the dist root) of the config we synthesize, and of its
/// upstream source. Any pre-existing `default.json5` in the dist is skipped in
/// favour of the rewritten one.
const DEFAULT_CONFIG_REL: &str = "config/default.json5";
const SOURCE_CONFIG_REL: &str = "config/r4.json5";

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

/// Read upstream `config/r4.json5` and rewrite it into the served
/// `config/default.json5` body. Panics with a precise message if the source is
/// missing or its format drifted — matching the TS generator's fail-loud
/// behaviour, so a stale vendor build is caught at compile time rather than
/// silently serving the public SMART sandbox.
fn synthesize_default_config(dist: &Path) -> Vec<u8> {
    let source_path = dist.join(SOURCE_CONFIG_REL);
    let source = std::fs::read_to_string(&source_path).unwrap_or_else(|error| {
        panic!(
            "vendor-apps-rust: {} present but {SOURCE_CONFIG_REL} could not be read ({error}) — \
             the patient-browser dist is incomplete; re-run the upstream build (see \
             vendor-apps/README)",
            dist.display(),
        )
    });
    assert!(
        source.contains(UPSTREAM_FHIR_URL),
        "vendor-apps-rust: {SOURCE_CONFIG_REL} no longer contains {UPSTREAM_FHIR_URL} — upstream \
         config format changed; update the rewrite constants in build.rs",
    );
    assert!(
        source.contains(UPSTREAM_TIMEOUT),
        "vendor-apps-rust: {SOURCE_CONFIG_REL} no longer contains '{UPSTREAM_TIMEOUT}' — upstream \
         config format changed; update the rewrite constants in build.rs",
    );
    source
        .replace(UPSTREAM_FHIR_URL, ONDEVICE_FHIR_URL)
        .replace(UPSTREAM_TIMEOUT, ONDEVICE_TIMEOUT)
        .into_bytes()
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

    // Cargo re-runs the build script when this path's directory listing changes;
    // per-file `rerun-if-changed` below covers edits to existing files. Printed
    // even when absent so populating the dist later triggers a rebuild.
    println!("cargo:rerun-if-changed={}", dist.display());

    let assets_rs = out_dir.join("assets.rs");

    if !dist.exists() {
        // No vendored build: emit an empty table. The crate compiles and the
        // routes 404 until someone populates the dist and rebuilds.
        std::fs::write(
            &assets_rs,
            "// vendor-apps-rust: patient-browser dist absent at build time.\n\
             pub static ASSETS: &[Asset] = &[];\n",
        )
        .expect("write empty assets.rs");
        return;
    }

    let mut files = Vec::new();
    walk(&dist, &mut files);

    // BTreeMap both de-dupes and sorts by path so the generated table is stable
    // across runs (and platforms with differing readdir order).
    let mut processed: BTreeMap<String, Processed> = BTreeMap::new();

    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
        let rel = rel_of(&dist, file);
        let ext = file
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();

        // Source maps bloat the binary and are never requested by the running
        // SPA; the synthesized default config replaces any committed one.
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

    // Synthesize the rewritten default config from upstream's r4.json5.
    println!(
        "cargo:rerun-if-changed={}",
        dist.join(SOURCE_CONFIG_REL).display()
    );
    processed.insert(
        DEFAULT_CONFIG_REL.to_owned(),
        Processed {
            content_type: "application/json; charset=utf-8",
            bytes: synthesize_default_config(&dist),
        },
    );

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

    std::fs::write(&assets_rs, table).expect("write generated assets.rs");
}
