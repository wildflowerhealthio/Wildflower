mod bridge;
mod loopback_consent_dialog;
mod native_webview_handle;

use anyhow::Context;
use background_server_service_rust::ServerHostContext;
use background_server_service_tauri_rust::{
    report_no_server, report_server_failure, start_background_server_service,
    WildflowerServerService,
};
use servers_rust::{JsonServerRegistry, RegistryError, ServerRecord, ServerRegistry};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::ServerRuntimeConfig;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_background_service::StartConfig;
use tauri_plugin_log::log;
use tokio::sync::watch;
use url::Url;
use wildflower_server_rust::{HostPorts, WildflowerServerConfig};

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

// How the background service starts the server, from the same
// `tauri-shared-config.json` (re-emitted by `build.rs`): the text of Android's
// persistent foreground-service notification and its foreground-service type.
// The TS shell imports the same pair from that file for the plugin's
// `configureRecovery` (`src/main.tsx`), so the restarts the plugin makes itself
// start the service as the host does.
const BACKGROUND_SERVICE_LABEL: &str = env!("WILDFLOWER_BACKGROUND_SERVICE_LABEL");
const BACKGROUND_SERVICE_FOREGROUND_TYPE: &str =
    env!("WILDFLOWER_BACKGROUND_SERVICE_FOREGROUND_TYPE");

/// Resolves the data root, the directory the host keeps everything in: the
/// server registry, saved files, and each server's own folder under
/// `servers/`. `Documents` on iOS, where it is the only part of the app
/// container the Files app will show, and Tauri's `app_data_dir()` everywhere
/// else. The iOS bundle has to opt in as well (see the [Data Directory
/// Explanation] for both halves, the layout, and what each platform resolves
/// to).
///
/// Only the platform's own candidate is resolved — `document_dir()` fails
/// outright on a desktop with no such user directory, and a platform that never
/// reads it must not be able to fail startup on it.
///
/// [Data Directory Explanation]: ../../Data%20Directory%20Explanation.md
fn resolve_data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<PathBuf> {
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

/// The host's scopes for its owner token, from `LOCAL_GRANTED_SCOPES`.
fn host_owner_scopes() -> Vec<String> {
    LOCAL_GRANTED_SCOPES
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// Resolves what the Wildflower server reads from this build and the
/// platform's paths into its [`WildflowerServerConfig`].
///
/// Only the desktop/iOS release build asks `app_handle` for Tauri's
/// bundled-resource dir, where it reads the FHIR SearchParameter bundle; the dev
/// build reads the workspace source tree, and Android the embedded copy, which
/// it writes into `data_root`: the bundle belongs to the install, not to one
/// server.
fn server_config(
    runtime: ServerRuntimeConfig,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] data_root: &Path,
    #[cfg_attr(target_os = "android", allow(unused_variables))] app_handle: &tauri::AppHandle,
) -> anyhow::Result<WildflowerServerConfig> {
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
    // bundle in the binary and materialize it into the data root at startup.
    // Because the APK-asset copy is never read on Android, `tauri.android.conf.json`
    // drops it from `bundle.resources` (a `null` merge-patch override) so the APK
    // ships the bundle once (the binary embed) rather than twice.
    // Desktop/iOS keep reading the deployed resource straight off disk (their
    // resource dir is a real directory).
    #[cfg(target_os = "android")]
    let search_parameter_data_dir = {
        const EMBEDDED_SEARCH_PARAMETERS_R4: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../slices/emr/emr-rust/assets/search-parameters-r4.json"
        ));
        // Filename matches `emr_rust`'s `SEARCH_PARAMETERS_R4_FILENAME` and the
        // `tauri.conf.json` resource mapping.
        let dir = data_root.join("fhir-search-params");
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
        app_handle.path().resource_dir()?.join("fhir-search-params")
    };
    Ok(WildflowerServerConfig {
        runtime,
        search_parameter_data_dir,
        owner_ui_base,
        host_owner_scopes: host_owner_scopes(),
        first_party_client_id: FIRST_PARTY_CLIENT_ID.to_owned(),
        tunnel_seed: tunnel_seed_from_build_env(),
    })
}

/// Find the registered server `setup()` runs: the first one set
/// [`running`](ServerRecord::running). `None` when no server is set running,
/// an empty registry included.
///
/// One server runs at a time for now; starting and stopping servers arrives
/// with the base's server commands in #955.
fn find_server_to_run(
    registry: &dyn ServerRegistry,
) -> Result<Option<ServerRecord>, RegistryError> {
    Ok(registry
        .read_all()?
        .into_iter()
        .find(|server| server.running))
}

/// Wraps the host's native adapters and bridge publishers as the server's
/// [`HostPorts`].
fn host_ports(app_handle: &tauri::AppHandle, publishers: bridge::BridgePublishers) -> HostPorts {
    HostPorts {
        // The native Approve / Reject dialog gatekeeper raises when the hosted
        // owner UI logs in over direct loopback (see `loopback_consent_dialog`).
        loopback_consent_prompt: Arc::new(
            loopback_consent_dialog::TauriLoopbackConsentPrompt::new(
                app_handle.clone(),
                host_owner_scopes(),
            ),
        ),
        // A loopback launch hands this the resolved URL to open in a native popup
        // (the server 204s). See `native_webview_handle`.
        on_device_webview_handle: Arc::new(native_webview_handle::NativeWebviewHandle::new(
            app_handle.clone(),
        )),
        // The server publishes the host owner token and pending-consent heads
        // here; `bridge::attach_bridge` documents how the resident task delivers
        // them to the webview. The senders outlive every server run, so a
        // restarted server publishes to the same webview.
        host_owner_token_sender: publishers.host_owner_token_sender,
        active_pending_consent_sender: publishers.active_pending_consent_sender,
    }
}

/// Build and run the Tauri application.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to start — an unrecoverable
/// windowing/context failure with no app handle through which to surface a
/// dialog, so dying with the error is the honest outcome. Recoverable startup
/// failures (e.g. the server registry) are handled inside `.setup()` where a
/// handle still exists.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The background service builds a fresh `WildflowerServerService` for every
    // start from the factory registered below, before `.setup()` can build the
    // server's context (its ports need the `AppHandle`). `.setup()` publishes
    // the context here, and each run waits for it.
    let (host_context_sender, host_context) = watch::channel::<Option<ServerHostContext>>(None);
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // Gated web→host data-plane transport for the desktop sniffer's
            // untrusted content webview — allowlists the inner `_tag` so the page
            // can't forge control tags it would otherwise reach via a bus `emit`
            // grant. See capabilities/native-webview-window.json.
            browser_sniffer_tauri_rust::native_webview_data_plane_emit,
            // The base's enrolment commands, granted to the `main` webview
            // only (`allow-server-enrolment`, see capabilities/default.json).
            servers_tauri_rust::server_add,
            servers_tauri_rust::server_set_credentials,
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
        // Before the background service, which posts its notifications through
        // it.
        .plugin(tauri_plugin_notification::init())
        // Runs the Wildflower server: in-process on desktop. The plugin's
        // `background-service` config in `tauri.conf.json` allowlists the
        // foreground-service type the server starts as.
        .plugin(tauri_plugin_background_service::init_with_service(
            move || WildflowerServerService::new(host_context.clone()),
        ))
        .setup(move |app| {
            let data_root = resolve_data_dir(app.handle())?;
            std::fs::create_dir_all(&data_root)?;

            // Attach the bridge before the server starts: `listen` registers
            // synchronously, so the webview's `__Ready` (which fires much
            // later, once the bundle runs) can't be missed even if the server
            // is slow to boot. The bridge owns its channel plumbing; the server
            // gets the publishers.
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
            // finished recording into `<data root>/saved_data`, shared by
            // every server, taking the directory this `setup()` already
            // resolved rather than its own.
            har_recorder_tauri_rust::attach_har_recorder(app.handle(), data_root.clone());

            // The registry the enrolment commands write, `servers.json` in the
            // same data root.
            servers_tauri_rust::manage_servers(app.handle(), &data_root);

            let server = match find_server_to_run(&JsonServerRegistry::in_data_root(&data_root)) {
                Ok(Some(server)) => server,
                // No server to run isn't a failure: the page shows the
                // server stopped, with no error.
                Ok(None) => {
                    report_no_server(app.handle());
                    return Ok(());
                }
                // Without the registry there is no server to run; say so
                // the way a failed run does, and keep the app up to show
                // it.
                Err(error) => {
                    report_server_failure(
                        app.handle(),
                        &format!("failed to read the registered servers: {error}"),
                    );
                    return Ok(());
                }
            };
            let server_dir = server.server_dir(&data_root);
            log::info!(
                "[servers] starting {} from {}",
                server.domain(),
                server_dir.display()
            );

            // Hostname/port come from the shared `tauri-shared-config.json`
            // (see `LOOPBACK_HOSTNAME`/`LOOPBACK_PORT`), the same file the
            // TS `apiBaseUrl` reads.
            let loopback_base_url =
                Url::parse(&format!("http://{}:{}", LOOPBACK_HOSTNAME, LOOPBACK_PORT))?;
            let runtime = ServerRuntimeConfig {
                // Loopback-only: the OS rejects non-local peers at the socket,
                // so the bearer secret is never the only thing between LAN
                // peers and FHIR health data.
                loopback_base_url,
                server_dir,
            };

            match server_config(runtime, &data_root, app.handle()) {
                Ok(config) => {
                    let (server_host_context, server_receivers) =
                        ServerHostContext::new(config, host_ports(app.handle(), publishers));
                    // Wire the server's status, restart and notifications
                    // before a run can begin, so no run-state change is
                    // missed, and start it from Rust, without waiting on the
                    // page. A run waits for the context published below.
                    start_background_server_service(
                        app.handle(),
                        server_receivers,
                        StartConfig {
                            service_label: BACKGROUND_SERVICE_LABEL.to_owned(),
                            foreground_service_type: BACKGROUND_SERVICE_FOREGROUND_TYPE.to_owned(),
                        },
                    );
                    host_context_sender.send_replace(Some(server_host_context));
                }
                // Without a config there is no server to run; say so the way
                // a failed run does, and keep the app up to show it.
                Err(error) => report_server_failure(app.handle(), &format!("{error:#}")),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use servers_rust::{JsonServerRegistry, ServerRecord, SERVERS_FILE_NAME};
    use std::path::Path;

    /// A `servers.json` in `data_root` holding a server on the official relay
    /// for each `(tunnel name, running)`, in order, written by hand as the
    /// enrolment commands would have left it.
    fn write_servers(data_root: &Path, servers: &[(&str, bool)]) {
        let servers: Vec<serde_json::Value> = servers
            .iter()
            .map(|(tunnel_name, running)| {
                serde_json::json!({
                    "relay": {"kind": "wildflowerOfficial"},
                    "tunnelName": tunnel_name,
                    "token": "s3cret-tunnel-token",
                    "publicSettings": {
                        "remoteAddr": "relay.wildflowerhealth.io:2333",
                        "transport": "noise",
                        "noisePattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                        "publicKey": "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=",
                        "domain": "relay.wildflowerhealth.io"
                    },
                    "launcherUrl": "https://wildflowerhealth.io/app",
                    "stagingCertificates": false,
                    "running": running
                })
            })
            .collect();
        std::fs::write(
            data_root.join(SERVERS_FILE_NAME),
            serde_json::json!({"version": 1, "servers": servers}).to_string(),
        )
        .expect("write servers.json");
    }

    /// The server `setup()` would run from `data_root`.
    fn server_to_run_in(data_root: &Path) -> Option<ServerRecord> {
        super::find_server_to_run(&JsonServerRegistry::in_data_root(data_root))
            .expect("servers.json reads")
    }

    #[test]
    fn an_empty_registry_runs_no_server() {
        let data_root = tempfile::tempdir().expect("temp data root");
        assert_eq!(server_to_run_in(data_root.path()), None);
        write_servers(data_root.path(), &[]);
        assert_eq!(server_to_run_in(data_root.path()), None);
    }

    #[test]
    fn a_registry_with_no_server_set_running_runs_none() {
        let data_root = tempfile::tempdir().expect("temp data root");
        write_servers(data_root.path(), &[("ruth", false), ("lab", false)]);
        assert_eq!(server_to_run_in(data_root.path()), None);
    }

    #[test]
    fn the_server_set_running_runs_from_its_own_folder() {
        let data_root = tempfile::tempdir().expect("temp data root");
        write_servers(data_root.path(), &[("ruth", true)]);
        let server = server_to_run_in(data_root.path()).expect("a server runs");
        assert_eq!(server.domain(), "ruth.relay.wildflowerhealth.io");
        assert_eq!(
            server.server_dir(data_root.path()),
            data_root
                .path()
                .join("servers")
                .join("ruth.relay.wildflowerhealth.io")
        );
    }

    #[test]
    fn the_first_server_set_running_is_the_one_that_runs() {
        let data_root = tempfile::tempdir().expect("temp data root");
        write_servers(
            data_root.path(),
            &[("lab", false), ("ruth", true), ("demo", true)],
        );
        let server = server_to_run_in(data_root.path()).expect("a server runs");
        assert_eq!(server.domain(), "ruth.relay.wildflowerhealth.io");
    }

    #[test]
    fn an_unreadable_registry_is_an_error() {
        let data_root = tempfile::tempdir().expect("temp data root");
        std::fs::write(
            data_root.path().join(SERVERS_FILE_NAME),
            r#"{"version": 2, "servers": []}"#,
        )
        .expect("write servers.json");
        assert!(
            super::find_server_to_run(&JsonServerRegistry::in_data_root(data_root.path())).is_err()
        );
    }

    /// The plugin checks the type the service starts as against its config's
    /// allowlist on every platform, so a type missing from `tauri.conf.json`
    /// would stop the server starting at all. Read through the plugin's own
    /// config type, which is what the plugin validates at startup.
    #[test]
    fn the_background_service_config_allows_the_service_s_foreground_type() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display())),
        )
        .expect("tauri.conf.json is JSON");
        let plugin_config: tauri_plugin_background_service::PluginConfig =
            serde_json::from_value(conf["plugins"]["background-service"].clone())
                .expect("the background-service plugin config decodes");
        plugin_config
            .validate()
            .expect("the background-service plugin config is valid");
        assert!(
            plugin_config
                .android_foreground_service_types
                .contains(&super::BACKGROUND_SERVICE_FOREGROUND_TYPE.to_owned()),
            "androidForegroundServiceTypes {:?} must allow the service's type",
            plugin_config.android_foreground_service_types
        );
        assert!(plugin_config.ios_requires_network_connectivity);
    }

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

    /// The strings in the `<array>` an Apple plist declares under `key`, read
    /// from the compacted text like the other plist checks; empty when the key
    /// is missing.
    fn plist_string_array(relative: &str, key: &str) -> Vec<String> {
        let compact = compact_apple_plist(relative);
        let opening = format!("<key>{key}</key><array>");
        let Some((_, after_opening)) = compact.split_once(&opening) else {
            return Vec::new();
        };
        let (array_body, _) = after_opening
            .split_once("</array>")
            .unwrap_or_else(|| panic!("{relative}'s {key} array is never closed"));
        array_body
            .split("<string>")
            .filter_map(|entry| entry.split_once("</string>"))
            .map(|(value, _)| value.to_owned())
            .collect()
    }

    /// The background service runs the server in the windows iOS grants
    /// `BGAppRefreshTask` and `BGProcessingTask`, which iOS starts only for the
    /// background modes and task identifiers the bundle declares. The plugin
    /// registers its tasks as the bundle identifier plus `.bg-refresh` and
    /// `.bg-processing` (`BackgroundServicePlugin.swift`), and Xcode expands
    /// `$(PRODUCT_BUNDLE_IDENTIFIER)` to that same identifier. Both iOS plists,
    /// for the same reason as the Files app keys.
    #[test]
    fn both_ios_plists_declare_background_tasks() {
        for relative in [
            "Info.ios.plist",
            "gen/apple/wildflower-tauri_iOS/Info.plist",
        ] {
            let background_modes = plist_string_array(relative, "UIBackgroundModes");
            for mode in ["fetch", "processing"] {
                assert!(
                    background_modes.iter().any(|declared| declared == mode),
                    "{relative} must list {mode} in UIBackgroundModes, or iOS never \
                     grants the server its background window; declared: {background_modes:?}"
                );
            }
            let task_identifiers =
                plist_string_array(relative, "BGTaskSchedulerPermittedIdentifiers");
            for suffix in ["bg-refresh", "bg-processing"] {
                let identifier = format!("$(PRODUCT_BUNDLE_IDENTIFIER).{suffix}");
                assert!(
                    task_identifiers.contains(&identifier),
                    "{relative} must permit {identifier}, or the plugin's task \
                     registration fails; declared: {task_identifiers:?}"
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

    const ANDROID_NAMESPACE: &str = "http://schemas.android.com/apk/res/android";
    const TOOLS_NAMESPACE: &str = "http://schemas.android.com/tools";
    const ANDROID_MANIFEST: &str = "gen/android/app/src/main/AndroidManifest.xml";

    /// Reads a file next to this crate.
    fn read_crate_file(relative: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
    }

    /// Reads the app's tracked Android manifest, the one the build merges the
    /// plugins' manifests into.
    fn read_android_manifest() -> String {
        read_crate_file(ANDROID_MANIFEST)
    }

    /// The `<{tag} android:name="{name}">` element in `manifest`, at any depth.
    fn android_element<'document>(
        manifest: &'document roxmltree::Document<'document>,
        tag: &str,
        name: &str,
    ) -> Option<roxmltree::Node<'document, 'document>> {
        manifest.descendants().find(|node| {
            node.has_tag_name(tag) && node.attribute((ANDROID_NAMESPACE, "name")) == Some(name)
        })
    }

    /// The background-service plugin's manifest asks for the permissions its
    /// calling and other foreground-service types use. Android grants every
    /// permission the merged manifest asks for, and Play reviews each, so the
    /// app's manifest removes all the server doesn't use from the merge.
    #[test]
    fn android_manifest_removes_the_plugin_s_unused_permissions() {
        let manifest_text = read_android_manifest();
        let manifest =
            roxmltree::Document::parse(&manifest_text).expect("the Android manifest is XML");
        for permission in [
            "android.permission.CAMERA",
            "android.permission.RECORD_AUDIO",
            "android.permission.MANAGE_OWN_CALLS",
            "android.permission.USE_FULL_SCREEN_INTENT",
            "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
            "android.permission.FOREGROUND_SERVICE_MICROPHONE",
            "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
            "android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING",
        ] {
            let removal = android_element(&manifest, "uses-permission", permission)
                .unwrap_or_else(|| panic!("{ANDROID_MANIFEST} must name {permission}"));
            assert_eq!(
                removal.attribute((TOOLS_NAMESPACE, "node")),
                Some("remove"),
                "{ANDROID_MANIFEST} must remove {permission} from the merge"
            );
        }
        // Telecom binds the plugin's call service only with MANAGE_OWN_CALLS,
        // removed above, so the service goes too.
        let call_service = android_element(
            &manifest,
            "service",
            "app.tauri.backgroundservice.BackgroundCallConnectionService",
        )
        .unwrap_or_else(|| panic!("{ANDROID_MANIFEST} must name the plugin's call service"));
        assert_eq!(
            call_service.attribute((TOOLS_NAMESPACE, "node")),
            Some("remove")
        );
    }

    /// The plugin declares its foreground service with every type it might
    /// start as. The app narrows it to the one the server starts as, which the
    /// plugin also checks a start against, and replaces the plugin's generic
    /// `specialUse` reason with the server's own.
    #[test]
    fn android_manifest_narrows_the_plugin_s_foreground_service() {
        let manifest_text = read_android_manifest();
        let manifest =
            roxmltree::Document::parse(&manifest_text).expect("the Android manifest is XML");
        let lifecycle_service = android_element(
            &manifest,
            "service",
            "app.tauri.backgroundservice.LifecycleService",
        )
        .unwrap_or_else(|| panic!("{ANDROID_MANIFEST} must declare the plugin's service"));
        assert_eq!(
            lifecycle_service.attribute((ANDROID_NAMESPACE, "foregroundServiceType")),
            Some(super::BACKGROUND_SERVICE_FOREGROUND_TYPE),
            "the service's foreground-service type must be the one the server starts as"
        );
        assert_eq!(
            lifecycle_service.attribute((TOOLS_NAMESPACE, "replace")),
            Some("android:foregroundServiceType"),
            "the type must replace the plugin's, not merge into it"
        );

        let special_use_subtype = lifecycle_service
            .children()
            .find(|node| {
                node.has_tag_name("property")
                    && node.attribute((ANDROID_NAMESPACE, "name"))
                        == Some("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE")
            })
            .unwrap_or_else(|| panic!("{ANDROID_MANIFEST} must give the service its subtype"));
        assert_eq!(
            special_use_subtype.attribute((TOOLS_NAMESPACE, "replace")),
            Some("android:value"),
            "the subtype must replace the plugin's generic one"
        );
        let subtype = special_use_subtype
            .attribute((ANDROID_NAMESPACE, "value"))
            .unwrap_or_else(|| panic!("{ANDROID_MANIFEST}'s subtype must have a value"));
        assert!(
            subtype.contains("health records"),
            "the subtype must say what the service does, not {subtype:?}"
        );
    }
}
