mod bridge;
mod loopback_consent_dialog;
mod native_webview_handle;

use anyhow::Context;
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::ServerRuntimeConfig;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio_util::sync::CancellationToken;
use url::Url;
use wildflower_server_rust::{HostPorts, ServerObservers, WildflowerServerConfig};

// Loopback hostname/port for the embedded API server, derived at compile time
// from the SINGLE SOURCE OF TRUTH
// `apps/wildflower-tauri/tauri-shared-config.json`. `build.rs` reads that file
// and re-emits these as `rustc-env` vars; the TS shell injects the same file
// as `WILDFLOWER_LOOPBACK_ORIGIN` (see `vite.config.ts` and `src/main.tsx`).
// Changing the JSON updates both sides — they can't drift. A non-numeric port
// in the JSON fails this `const` parse at compile time rather than at bind
// time.
const LOOPBACK_HOSTNAME: &str = env!("WILDFLOWER_LOOPBACK_HOSTNAME");
const LOOPBACK_PORT: u16 = match u16::from_str_radix(env!("WILDFLOWER_LOOPBACK_PORT"), 10) {
    Ok(port) => port,
    Err(_) => panic!("WILDFLOWER_LOOPBACK_PORT (from tauri-shared-config.json) must be a u16"),
};

// The host's granted-scope string, also sourced from
// `apps/wildflower-tauri/tauri-shared-config.json` (re-emitted by `build.rs`).
// The TS shell reads the same value as `WILDFLOWER_LOCAL_GRANTED_SCOPES`
// (`vite.config.ts`), so the host's device-authorization request can't drift
// from what gatekeeper seeds. gatekeeper seeds its first-party client's
// `allowed_scopes` and mints the host owner token from this set (asserting it
// covers `WILDFLOWER_WIDEST_SCOPES`).
const LOCAL_GRANTED_SCOPES: &str = env!("WILDFLOWER_LOCAL_GRANTED_SCOPES");

// The host's first-party OAuth `client_id`, sourced from the same
// `apps/wildflower-tauri/tauri-shared-config.json` (re-emitted by `build.rs`).
// The TS shell reads the same value as `WILDFLOWER_FIRST_PARTY_CLIENT_ID`
// (`vite.config.ts`), so the WebView's device-login `client_id` can't drift from
// the id gatekeeper seeds the first-party client and mints the owner token under.
const FIRST_PARTY_CLIENT_ID: &str = env!("WILDFLOWER_FIRST_PARTY_CLIENT_ID");

// The hosted owner UI (see `shared_structures_rust::owner_ui`), sourced from the
// same `tauri-shared-config.json` (re-emitted by `build.rs`). Debug builds use
// the local `main-web` dev server, so a dev host's links open the UI being
// worked on rather than the published one.
const OWNER_UI_BASE_URL: &str = if cfg!(debug_assertions) {
    env!("WILDFLOWER_OWNER_UI_DEV_BASE_URL")
} else {
    env!("WILDFLOWER_OWNER_UI_BASE_URL")
};

/// Resolves the directory the host keeps its databases and saved files in:
/// `Documents` on iOS, where it is the only part of the app container the Files
/// app will show, and Tauri's `app_data_dir()` everywhere else. The iOS bundle
/// has to opt in as well (see the [Data Directory Explanation] for both halves,
/// and what each platform resolves to).
///
/// Only the platform's own candidate is resolved — `document_dir()` fails
/// outright on a desktop with no such user directory, and a platform that never
/// reads it must not be able to fail startup on it.
///
/// [Data Directory Explanation]: ../../Data%20Directory%20Explanation.md
fn resolve_data_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<std::path::PathBuf> {
    #[cfg(target_os = "ios")]
    return app.path().document_dir();
    #[cfg(not(target_os = "ios"))]
    return app.path().app_data_dir();
}

/// Build-time tunnel connection defaults, baked into the binary so a
/// reinstall re-seeds them (see `tunnel_rust::SqliteTunnelStore::seed_if_absent`,
/// which only fills unconfigured fields). The relay is seeded only when all
/// four fields are present at build time.
///
/// SECURITY: `WILDFLOWER_TUNNEL_RELAY_TOKEN` is compiled into the distributed
/// binary (an extractable artifact) — an accepted trade-off so the relay
/// connection survives reinstalls, token included, without re-entry.
fn tunnel_seed_from_build_env() -> tunnel_rust::SettingsSeed {
    // Treat an empty value as absent: a blank `.env` entry is forwarded by
    // `dotenvy` as `Some("")`, which would otherwise seed a half-configured
    // relay (and an empty token reads back as unconfigured anyway).
    let non_empty = |value: &'static str| (!value.is_empty()).then_some(value);
    let relay = match (
        option_env!("WILDFLOWER_TUNNEL_RELAY_REMOTE_ADDR").and_then(non_empty),
        option_env!("WILDFLOWER_TUNNEL_RELAY_TOKEN").and_then(non_empty),
        option_env!("WILDFLOWER_TUNNEL_RELAY_PUBLIC_KEY").and_then(non_empty),
        option_env!("WILDFLOWER_TUNNEL_RELAY_SERVICE_NAME").and_then(non_empty),
    ) {
        (Some(remote_addr), Some(token), Some(public_key), Some(service_name)) => {
            Some(tunnel_rust::RelaySettings {
                remote_addr: remote_addr.to_owned(),
                token: token.to_owned(),
                public_key: public_key.to_owned(),
                service_name: service_name.to_owned(),
            })
        }
        _ => None,
    };
    tunnel_rust::SettingsSeed {
        public_host: option_env!("WILDFLOWER_TUNNEL_PUBLIC_HOST")
            .and_then(non_empty)
            .map(str::to_owned),
        relay,
    }
}

/// Runs the Wildflower server for the app's lifetime: resolves what it reads
/// from this build and the platform's paths into its
/// [`WildflowerServerConfig`], wraps the host's native adapters and bridge
/// publishers as its [`HostPorts`], and serves.
async fn run_server(
    runtime: ServerRuntimeConfig,
    publishers: bridge::BridgePublishers,
    app_handle: tauri::AppHandle,
    // Tauri's bundled-resource directory, resolved in `.setup()` (where the
    // `AppHandle` path API is available) and threaded in rather than added to
    // `ServerRuntimeConfig`. The desktop/iOS release build reads the FHIR
    // SearchParameter bundle from it; the dev build ignores it in favour of the
    // workspace source tree, and Android in favour of the embedded copy.
    resource_dir: std::path::PathBuf,
) -> anyhow::Result<()> {
    let owner_ui_base = OwnerUiBase::parse(OWNER_UI_BASE_URL)
        .context("owner_ui_base_url (from tauri-shared-config.json) must be an absolute URL")?;
    // The FHIR R4 SearchParameter bundle HFS indexes from is a deployed asset,
    // not embedded in the binary — dev reads it from the workspace source tree,
    // release from the bundled resource dir (declared in `tauri.conf.json` under
    // `bundle.resources`, copied to `<resource_dir>/fhir-search-params/`).
    // Android: `bundle.resources` land in the APK's `assets/`, which are NOT real
    // filesystem paths — `resource_dir()` returns a virtual path `std::fs` (and so
    // HFS's `SqliteBackend`) can't read, and HFS `bail!`s "bundle not found". Tauri
    // exposes no Rust-side reader for bundle resources (`AssetResolver` covers only
    // `frontendDist`), and reading the APK asset directly needs the `unsafe` JNI
    // `AssetManager` the workspace forbids. So on Android we embed the ~2.3 MB
    // bundle in the binary and materialize it to a real app-data dir at startup.
    // Because the APK-asset copy is never read on Android, `tauri.android.conf.json`
    // drops it from `bundle.resources` (a `null` merge-patch override) so the APK
    // ships the bundle once (the binary embed) rather than twice.
    // Desktop/iOS keep reading the deployed resource straight off disk (their
    // resource dir is a real directory).
    #[cfg(target_os = "android")]
    let search_parameter_data_dir = {
        // Android reads the embedded bundle, never the resource dir.
        drop(resource_dir);
        const EMBEDDED_SEARCH_PARAMETERS_R4: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../slices/emr/emr-rust/assets/search-parameters-r4.json"
        ));
        // Filename matches `emr_rust`'s `SEARCH_PARAMETERS_R4_FILENAME` and the
        // `tauri.conf.json` resource mapping.
        let dir = runtime.app_data_dir.join("fhir-search-params");
        std::fs::create_dir_all(&dir).with_context(|| {
            format!("failed to create fhir-search-params dir {}", dir.display())
        })?;
        let file = dir.join("search-parameters-r4.json");
        // Materialize the embedded bundle only when the on-disk copy is missing
        // or differs from what this build carries — an app update ships fresh
        // bytes and triggers a rewrite, while an unchanged bundle skips the
        // ~2.3 MB write on every cold start. A cheap length check short-circuits
        // the common already-current case before the byte-for-byte compare.
        let up_to_date = std::fs::metadata(&file)
            .ok()
            .filter(|m| m.len() == EMBEDDED_SEARCH_PARAMETERS_R4.len() as u64)
            .and_then(|_| std::fs::read(&file).ok())
            .is_some_and(|existing| existing == EMBEDDED_SEARCH_PARAMETERS_R4);
        if !up_to_date {
            std::fs::write(&file, EMBEDDED_SEARCH_PARAMETERS_R4).with_context(|| {
                format!(
                    "failed to materialize embedded SearchParameter bundle to {}",
                    file.display()
                )
            })?;
        }
        dir
    };
    #[cfg(not(target_os = "android"))]
    let search_parameter_data_dir = if cfg!(debug_assertions) && !cfg!(mobile) {
        std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../slices/emr/emr-rust/assets"
        ))
    } else {
        resource_dir.join("fhir-search-params")
    };
    let host_owner_scopes: Vec<String> = LOCAL_GRANTED_SCOPES
        .split_whitespace()
        .map(str::to_owned)
        .collect();

    let host_ports = HostPorts {
        // The native Approve / Reject dialog gatekeeper raises when the hosted
        // owner UI logs in over direct loopback (see `loopback_consent_dialog`).
        loopback_consent_prompt: Arc::new(
            loopback_consent_dialog::TauriLoopbackConsentPrompt::new(
                app_handle.clone(),
                host_owner_scopes.clone(),
            ),
        ),
        // A loopback launch hands this the resolved URL to open in a native popup
        // (the server 204s). See `native_webview_handle`.
        on_device_webview_handle: Arc::new(native_webview_handle::NativeWebviewHandle::new(
            app_handle,
        )),
        // The server publishes the host owner token and pending-consent heads
        // here; `bridge::attach_bridge` documents how the resident task delivers
        // them to the webview.
        host_owner_token_sender: publishers.host_owner_token_sender,
        active_pending_consent_sender: publishers.active_pending_consent_sender,
    };
    let config = WildflowerServerConfig {
        runtime,
        search_parameter_data_dir,
        owner_ui_base,
        host_owner_scopes,
        first_party_client_id: FIRST_PARTY_CLIENT_ID.to_owned(),
        tunnel_seed: tunnel_seed_from_build_env(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
    };

    // Nothing watches the server's observers yet, so their receivers are
    // dropped: the server copies into the liveness watch regardless, and drops
    // its forwarded-request reports.
    let (tunnel_liveness_sender, _) = tokio::sync::watch::channel(None);
    let (forwarded_request_sender, _) = tokio::sync::mpsc::channel(1);
    let observers = ServerObservers {
        tunnel_liveness_sender,
        forwarded_request_sender,
    };
    // The server runs for the app's lifetime, so nothing cancels its shutdown
    // token.
    wildflower_server_rust::set_up(config, host_ports, observers)
        .await?
        .serve(CancellationToken::new())
        .await
}

/// Build and run the Tauri application.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to start — an unrecoverable
/// windowing/context failure with no app handle through which to surface a
/// dialog, so dying with the error is the honest outcome. Recoverable startup
/// failures (e.g. the app-data directory) are handled inside `.setup()` where a
/// handle still exists.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // Gated web→host data-plane transport for the desktop sniffer's
            // untrusted content webview — allowlists the inner `_tag` so the page
            // can't forge control tags it would otherwise reach via a bus `emit`
            // grant. See capabilities/native-webview-window.json.
            browser_sniffer_tauri_rust::native_webview_data_plane_emit
        ])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Native web view, presenting external URLs with native chrome
        // and document-start JS injection — the native counterpart to the
        // browser-sniffer WebviewWindow path, which stays in place. iOS uses a
        // WKWebView, Android an android.webkit.WebView, desktop a Tauri
        // WebviewWindow (scoped by capabilities/native-webview-window.json).
        .plugin(tauri_plugin_native_webview::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Stdout only — no Webview target, so host logs never
                // re-enter the webview. Keeps the log flow one-way:
                // webview console → `bridge:Log` → here (a Webview
                // target would loop those right back out).
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                )])
                .level(tauri_plugin_log::log::LevelFilter::Debug)
                // rathole logs every relay heartbeat/data-channel event at
                // debug — far too repetitive to read the tunnel lifecycle
                // through. Pin it to info; the tunnel slice's own
                // dial/probe/transition logs carry the timeline we care about.
                .level_for("rathole", tauri_plugin_log::log::LevelFilter::Warn)
                .level_for(
                    "hyper_util::client::legacy",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                // Tunnel daemon heartbeats on debug
                .level_for(
                    "tunnel_rust::domain::tunnel_daemon",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                // Helios's logging can be very chatty at debug, especially the auth middleware, so pin it to info
                .level_for(
                    "helios_rest::middleware::auth",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                .level_for(
                    "helios_auth::jwks",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                .level_for(
                    "helios_rest::handlers",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                // Tower has a number of loggers that are redundant unless you're particularly debugging a specific tower service.
                .level_for(
                    "tower_http::trace::on_eos",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                .level_for(
                    "tower_http::trace::on_request",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                // `h2`'s frame-level codec chatter rides the tracing→log bridge
                // and would drown the console at debug. Pin the whole `h2` tree
                // to warn — we never debug the codec here.
                .level_for("h2", tauri_plugin_log::log::LevelFilter::Warn)
                .build(),
        )
        .setup(|app| {
            let app_data_dir = resolve_data_dir(app.handle())?;
            std::fs::create_dir_all(&app_data_dir)?;

            // Tauri's bundled-resource dir — resolved here (the path API needs
            // the `AppHandle`) and threaded into the server task, which reads
            // the FHIR SearchParameter bundle from it in a release build.
            let resource_dir = app.path().resource_dir()?;

            // Attach the bridge before the server task spawns: `listen`
            // registers synchronously, so the webview's `__Ready` (which
            // fires much later, once the bundle runs) can't be missed
            // even if the server is slow to boot. The bridge owns its
            // channel plumbing; the server task gets the publishers.
            let publishers = bridge::attach_bridge(app.handle());

            // Wire the CollectorBridge.webToHost listeners that manage the
            // sniffer child webview lifecycle (open / navigate / close).
            // Sniffer-emitted data-plane events (`bridge:ResponseStart`
            // etc.) reach the React SPA on the global Tauri event bus, but
            // never straight from the untrusted content webview: the host
            // allowlists their inner `_tag` first (the mobile channel's
            // `validate_native_webview_message`, the desktop content webview's
            // `native_webview_data_plane_emit` command) and re-broadcasts.
            browser_sniffer_tauri_rust::attach_browser_sniffer(app.handle());

            // Wire the HarRecorderBridge.webToHost listener that writes a
            // finished recording into `<app data dir>/saved_data`, taking the
            // directory this `setup()` already resolved rather than its own.
            har_recorder_tauri_rust::attach_har_recorder(app.handle(), app_data_dir.clone());

            let error_handle = app.handle().clone();
            // The server task installs the apps on-device webview handle once
            // the apps slice is built; the handle opens launched apps in a
            // native webview popup, so it needs an app handle.
            let server_handle = app.handle().clone();

            // Hostname/port come from the shared `tauri-shared-config.json`
            // (see `LOOPBACK_HOSTNAME`/`LOOPBACK_PORT`), the same file the
            // TS `apiBaseUrl` reads.
            let loopback_base_url =
                Url::parse(&format!("http://{}:{}", LOOPBACK_HOSTNAME, LOOPBACK_PORT))?;

            tauri::async_runtime::spawn(async move {
                let runtime = ServerRuntimeConfig {
                    // Loopback-only: the OS rejects non-local peers at the
                    // socket, so the bearer secret is never the only thing
                    // between LAN peers and FHIR health data.
                    loopback_base_url,
                    app_data_dir,
                };

                if let Err(error) =
                    run_server(runtime, publishers, server_handle, resource_dir).await
                {
                    tauri_plugin_log::log::error!("Wildflower server stopped: {error:?}");
                    // A failed/stopped server leaves the webview unable to
                    // reach the API at all (no token, no FHIR) — surface it
                    // with a native dialog instead of dying silently in the
                    // logs. A native dialog (not a webview message) is used
                    // deliberately: it shows even when the webview itself can't
                    // load. Blocking is fine here — the server is already dead.
                    error_handle
                        .dialog()
                        .message(format!("Wildflower server stopped: {error:#}"))
                        .kind(MessageDialogKind::Error)
                        .title("Wildflower")
                        .blocking_show();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// Reads one of the Apple plists next to this crate and flattens it, so a
    /// key and its value compare as one token however the file indents them.
    /// The files' comments name keys in backticks rather than as `<key>`
    /// elements, so a flattened comment can't satisfy an assertion below.
    fn compact_apple_plist(relative: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        let plist = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
        plist.split_whitespace().collect()
    }

    /// Both keys, in both iOS plists: the Files app lists the host's data
    /// directory under "On My iPhone" only when the bundle declares each, and
    /// only the overlay *and* the generated plist together cover both a CLI and
    /// an Xcode-opened build. Losing any of the four silently un-does the
    /// feature — see the [Data Directory Explanation].
    ///
    /// [Data Directory Explanation]: ../../Data%20Directory%20Explanation.md
    #[test]
    fn both_ios_plists_declare_files_app_keys() {
        for relative in [
            "Info.ios.plist",
            "gen/apple/wildflower-tauri_iOS/Info.plist",
        ] {
            let compact = compact_apple_plist(relative);
            for key in ["UIFileSharingEnabled", "LSSupportsOpeningDocumentsInPlace"] {
                assert!(
                    compact.contains(&format!("<key>{key}</key><true/>")),
                    "{relative} must declare {key} as true, or the data directory \
                     stays invisible in the Files app"
                );
            }
        }
    }

    /// Every `<key>` either overlay declares, nested ones included, paired with
    /// the value token that follows it — reading the compacted text rather than
    /// parsing XML. The value is the whole `<string>…</string>` for a string,
    /// the self-closing `<true/>`/`<false/>` for a boolean, and the opening tag
    /// alone for a container (`<dict>`, `<array>`), whose own keys arrive as
    /// entries of their own.
    fn declared_entries(relative: &str) -> Vec<(String, String)> {
        let compact = compact_apple_plist(relative);
        compact
            .split("<key>")
            .skip(1)
            .filter_map(|rest| rest.split_once("</key>"))
            .map(|(key, after)| {
                let end = if after.starts_with("<string>") {
                    after.find("</string>").map(|at| at + "</string>".len())
                } else {
                    // `<true/>`, `<dict>`, … — everything up to the first `>`.
                    after.find('>').map(|at| at + 1)
                };
                let value = &after[..end.unwrap_or(after.len())];
                (key.to_owned(), value.to_owned())
            })
            .collect()
    }

    /// The generated iOS plist is a hand-maintained copy of what the overlays
    /// declare — `tauri ios build` merges them, but an Xcode-opened build of
    /// `gen/apple/wildflower-tauri.xcodeproj` reads the generated file alone.
    /// Rather than let the copies drift, derive the expectation from the
    /// overlays: every key they declare has to appear in the generated plist
    /// *with the same value*, so neither a key added to an overlay later nor a
    /// reworded string can be silently left out of it.
    #[test]
    fn overlay_keys_reach_the_generated_ios_plist() {
        let generated = compact_apple_plist("gen/apple/wildflower-tauri_iOS/Info.plist");
        for overlay in ["Info.plist", "Info.ios.plist"] {
            for (key, value) in declared_entries(overlay) {
                assert!(
                    generated.contains(&format!("<key>{key}</key>{value}")),
                    "{overlay} declares {key} as {value}, which the generated iOS \
                     plist must declare identically — an Xcode-opened build never \
                     runs the merge, so a drifted copy ships as it stands"
                );
            }
        }
    }

    /// The host loads cleartext HTTP off loopback and, in a debug build, off a
    /// LAN dev server; without these keys the OS blocks both, the local-network
    /// one without even prompting. The negative assertion is the load-bearing
    /// half — it holds the exemptions scoped, so nobody reaches for the blanket
    /// switch. See the [Data Directory Explanation].
    ///
    /// [Data Directory Explanation]: ../../Data%20Directory%20Explanation.md
    #[test]
    fn apple_plists_declare_local_network_access() {
        for relative in ["Info.plist", "gen/apple/wildflower-tauri_iOS/Info.plist"] {
            let compact = compact_apple_plist(relative);
            assert!(
                compact.contains("<key>NSLocalNetworkUsageDescription</key><string>"),
                "{relative} must declare NSLocalNetworkUsageDescription, or a \
                 connection off loopback is denied without a prompt"
            );
            assert!(
                compact.contains("<key>NSAppTransportSecurity</key><dict>"),
                "{relative} must declare NSAppTransportSecurity, or ATS blocks the \
                 host's own cleartext HTTP"
            );
            for key in [
                "NSAllowsLocalNetworking",
                "NSAllowsArbitraryLoadsInWebContent",
            ] {
                assert!(
                    compact.contains(&format!("<key>{key}</key><true/>")),
                    "{relative} must declare {key} as true inside \
                     NSAppTransportSecurity"
                );
            }
        }

        // The blanket switch: superseded by the scoped keys above on these
        // deployment targets, and the one App Store review asks about. Checked
        // over all three plists, `Info.ios.plist` included — it carries no ATS
        // keys today, but it is the overlay `tauri ios build` merges *last*, so
        // a blanket switch added there would win on the shipped iOS bundle.
        for relative in [
            "Info.plist",
            "Info.ios.plist",
            "gen/apple/wildflower-tauri_iOS/Info.plist",
        ] {
            assert!(
                !compact_apple_plist(relative).contains("<key>NSAllowsArbitraryLoads</key>"),
                "{relative} must not disable ATS wholesale — the scoped keys cover \
                 what the host actually loads"
            );
        }
    }
}
