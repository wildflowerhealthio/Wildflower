//! The launch command: the base opens a server's launcher, an app, as a SMART
//! EHR launch against the server. The launcher's URL comes from the server's
//! record; the server must be launchable now
//! ([`ensure_launchable`](servers_rust::ensure_launchable)); its run's
//! gatekeeper mints a launch for any client on a blocking thread
//! ([`ServerLaunchMinter`]); and the launcher opens at
//! [`launch_url`](servers_rust::launch_url) in a native web view of its own,
//! [`LauncherWindows`]. The outcome is logged by domain.
//!
//! Launching never changes the server's run policy: a server that isn't
//! launchable answers at once, and the base waits for it to become so.
//! Every failure answers as `{kind, message}`, a [`LaunchError`].

use std::sync::Arc;

use gatekeeper_rust::domain::gatekeeper_error::GatekeeperError;
use servers_rust::{LaunchError, RegistryError, ServerDetail, ServerLaunchMinter, ServerRegistry};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_webview::{
    DismissalAction, NativeWebviewEvent, NativeWebviewExt, OpenRequest,
};
use tauri_unit_runner::UnitStatuses;
use url::Url;

use crate::ServersState;

/// Open the server `domain`'s launcher as a SMART EHR launch against it, with
/// a launch minted for any client. Invoked as
/// `invoke('server_launch', { domain })`; answers with nothing once the
/// launcher's window is open.
///
/// # Errors
///
/// The [`LaunchError`] that stopped it: the server isn't registered, isn't
/// launchable now, or its gatekeeper or the window failed.
#[tauri::command]
pub async fn server_launch(
    app: AppHandle,
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<(), LaunchError> {
    launch(
        Arc::clone(&servers.registry),
        &servers.server_units.statuses(),
        domain,
        NativeWebviewLauncherWindows { app },
    )
    .await
}

/// Opens a server's launcher: in the app, a native web view per server; in
/// the tests, a record of what was opened.
pub(crate) trait LauncherWindows: Send + 'static {
    /// Open the server `domain`'s launcher at `launch_url` and show it. It
    /// blocks until the window is open: call it on a blocking thread.
    ///
    /// # Errors
    ///
    /// [`LaunchError::OpeningLauncher`] when the window couldn't be opened.
    fn open(&self, domain: &str, launch_url: Url) -> Result<(), LaunchError>;
}

async fn launch(
    registry: Arc<dyn ServerRegistry>,
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    launcher_windows: impl LauncherWindows,
) -> Result<(), LaunchError> {
    let result = async {
        let launcher_url = registered_launcher_url(registry, domain.clone()).await?;
        let launch_minter = ServerLaunchMinter::of_launchable_server(statuses, &domain)?;
        let launch = tokio::task::spawn_blocking(move || launch_minter.mint())
            .await
            .map_err(|error| {
                LaunchError::Gatekeeper(GatekeeperError::infrastructure("minting a launch", error))
            })??;
        let launch_url = servers_rust::launch_url(&launcher_url, &domain, &launch);
        let opened_domain = domain.clone();
        tokio::task::spawn_blocking(move || launcher_windows.open(&opened_domain, launch_url))
            .await
            .map_err(|error| LaunchError::OpeningLauncher {
                reason: error.to_string(),
            })?
    }
    .await;
    match &result {
        Ok(()) => log::info!("[servers] launched the launcher of {domain}"),
        Err(error) => log::warn!("[servers] launching the launcher of {domain} failed: {error}"),
    }
    result
}

/// The launcher URL of the server `domain`, as `servers.json` holds it, read
/// on a blocking thread.
async fn registered_launcher_url(
    registry: Arc<dyn ServerRegistry>,
    domain: String,
) -> Result<Url, LaunchError> {
    tokio::task::spawn_blocking(move || registry.read(&domain).map(|record| record.launcher_url))
        .await
        .map_err(|error| RegistryError::storage("reading a server's launcher", error))?
        .map_err(LaunchError::from)
}

/// The native web view instance id of the server `domain`'s launcher,
/// `launcher-<domain>` with each `.` as `_`: one per server, so several
/// launchers can be open at once. A Tauri window label can't hold a `.`, and a
/// domain's DNS labels hold no `_`, so two domains never share an id.
fn launcher_webview_id(domain: &str) -> String {
    format!("launcher-{}", domain.replace('.', "_"))
}

/// The app's launcher windows: a native web view per server, titled with its
/// domain. A user dismissal disposes it, so a closed launcher stops counting
/// as an open window for the `WhileOpen` run policy.
struct NativeWebviewLauncherWindows {
    app: AppHandle,
}

impl LauncherWindows for NativeWebviewLauncherWindows {
    /// `open_url`s the launch URL, then `show`s it (two calls, per the
    /// plugin's visibility-independent-of-content model). A second launch of
    /// the same server navigates its open launcher. The launcher has no
    /// host↔page bridge, so it injects no script and its event channel is a
    /// no-op; nothing is seeded into its cookie jar, and it downloads nothing.
    fn open(&self, domain: &str, launch_url: Url) -> Result<(), LaunchError> {
        let id = launcher_webview_id(domain);
        let opening_failed =
            |error: tauri_plugin_native_webview::Error| LaunchError::OpeningLauncher {
                reason: error.to_string(),
            };
        self.app
            .native_webview()
            .open_url(
                &id,
                OpenRequest {
                    url: launch_url.to_string(),
                    init_script: None,
                    native_webview_event_channel: Channel::<NativeWebviewEvent>::new(|_event| {
                        Ok(())
                    }),
                    initial_title: Some(domain.to_owned()),
                    initial_subtitle: None,
                    initial_message: None,
                    cookies: Vec::new(),
                    download_dir: None,
                    on_dismiss: DismissalAction::Dispose,
                },
            )
            .map_err(opening_failed)?;
        self.app.native_webview().show(&id).map_err(opening_failed)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use rathole_settings_rust::TunnelName;
    use servers_rust::{
        CertificateAuthority, JsonServerRegistry, RelayKind, RunPolicy, ServerRecord, TunnelToken,
    };
    use shared_structures_rust::health_check::HealthReport;
    use tauri_unit_runner::{RunState, UnitId, UnitStatus};
    use wildflower_server_rust::{CertificateState, CertificateStatus, ServerHealth};

    use super::*;
    use crate::test_gatekeeper::{test_gatekeeper, TestGatekeeper, DOMAIN};

    const LAUNCHER: &str = "https://launcher.example/app?theme=dark";

    /// Launcher windows that record each launch URL they open.
    #[derive(Clone, Default)]
    struct OpenedLaunchers(Arc<Mutex<Vec<(String, Url)>>>);

    impl LauncherWindows for OpenedLaunchers {
        fn open(&self, domain: &str, launch_url: Url) -> Result<(), LaunchError> {
            self.0.lock().unwrap().push((domain.to_owned(), launch_url));
            Ok(())
        }
    }

    /// A registry in a fresh folder holding the server [`DOMAIN`], whose
    /// launcher is [`LAUNCHER`].
    fn registry() -> (tempfile::TempDir, Arc<dyn ServerRegistry>) {
        let data_root = tempfile::tempdir().unwrap();
        let registry = JsonServerRegistry::in_data_root(data_root.path());
        let record = ServerRecord {
            relay: RelayKind::Rathole,
            tunnel_name: TunnelName::parse("ruth").unwrap(),
            token: TunnelToken::new("the-token"),
            public_settings: serde_json::from_value(serde_json::json!({
                "remote_addr": "relay.example.com:2333",
                "transport": "noise",
                "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                "public_key": "Y2FmZWJhYmVjYWZlYmFiZWNhZmViYWJlY2FmZWJhYmU=",
                "domain": "relay.example.com",
            }))
            .unwrap(),
            launcher_url: Url::parse(LAUNCHER).unwrap(),
            certificate_authority: CertificateAuthority::LetsEncrypt,
            run_policy: RunPolicy::WhileOpen,
        };
        assert_eq!(record.domain(), DOMAIN);
        registry.insert(Box::new(move |_| record)).unwrap();
        (data_root, Arc::new(registry))
    }

    /// The servers' statuses with the server's run up over `gatekeeper`,
    /// reachable through its relay, with a valid certificate.
    fn launchable(gatekeeper: &TestGatekeeper) -> UnitStatuses<ServerDetail> {
        let detail = ServerDetail {
            health: Some(ServerHealth::Reachable(HealthReport::pass())),
            certificate: Some(CertificateState {
                status: CertificateStatus::NoRenewalNeeded,
                issuer: CertificateAuthority::LetsEncrypt,
                held: None,
                last_error: None,
            }),
            pending_consent: None,
            consent_decider: None,
            launch_minter: Some(ServerLaunchMinter::new(
                gatekeeper.launch_context_minter.clone(),
            )),
        };
        let status = UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: Some(detail),
        };
        [(UnitId::new(DOMAIN), status)].into()
    }

    #[test]
    fn each_server_s_launcher_is_its_own_instance_with_a_label_safe_id() {
        assert_eq!(
            launcher_webview_id("ruth.relay.example.com"),
            "launcher-ruth_relay_example_com"
        );
        assert_ne!(
            launcher_webview_id("ruth.relay.example.com"),
            launcher_webview_id("lab.relay.example.com")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launchable_server_s_launcher_opens_at_its_launch_url() {
        let gatekeeper = test_gatekeeper();
        let (_data_root, registry) = registry();
        let opened = OpenedLaunchers::default();

        launch(
            registry,
            &launchable(&gatekeeper),
            DOMAIN.to_owned(),
            opened.clone(),
        )
        .await
        .unwrap();

        let opened = opened.0.lock().unwrap();
        let [(domain, launch_url)] = opened.as_slice() else {
            panic!("one launcher opens: {opened:?}");
        };
        assert_eq!(domain, DOMAIN);
        let query: Vec<(String, String)> = launch_url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(query[0], ("theme".to_owned(), "dark".to_owned()));
        assert_eq!(
            query[1],
            ("iss".to_owned(), format!("https://{DOMAIN}/fhir-r4"))
        );
        assert_eq!(query[2].0, "launch");
        assert!(!query[2].1.is_empty(), "a minted launch: {launch_url}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_isn_t_launchable_opens_nothing() {
        let (_data_root, registry) = registry();
        let opened = OpenedLaunchers::default();
        let not_running: UnitStatuses<ServerDetail> =
            [(UnitId::new(DOMAIN), UnitStatus::never_run())].into();

        let refused = launch(registry, &not_running, DOMAIN.to_owned(), opened.clone()).await;

        assert!(
            matches!(refused, Err(LaunchError::ServerNotRunning { .. })),
            "{refused:?}"
        );
        assert!(opened.0.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_isn_t_registered_is_refused() {
        let gatekeeper = test_gatekeeper();
        let (_data_root, registry) = registry();
        let opened = OpenedLaunchers::default();

        let refused = launch(
            registry,
            &launchable(&gatekeeper),
            "lab.relay.example.com".to_owned(),
            opened.clone(),
        )
        .await;

        assert_eq!(refused.map_err(|error| error.kind()), Err("notRegistered"));
        assert!(opened.0.lock().unwrap().is_empty());
    }
}
