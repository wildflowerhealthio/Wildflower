//! The launch command: the base opens a server's launcher, an app, as a SMART
//! EHR launch against the server. The launcher's URL comes from the server's
//! record; the server must be launchable now, by the status the base
//! receives ([`ensure_launchable`](wildflowerhealthio_servers::ensure_launchable)); its run's
//! gatekeeper mints a launch for any client on a blocking thread
//! ([`ServerLaunchMinter`]); and the launcher opens at
//! [`launch_url`](wildflowerhealthio_servers::launch_url) in the in-app
//! browser, [`LaunchBrowser`], which shows one view at a time: on iOS a launch
//! replaces the view an earlier one opened, and on Android a launch that
//! arrives while an earlier one's view is still opening joins that view. While a launch's view is open it counts toward the
//! `WhileOpen` run policy ([`LaunchPresence`]), until the browser reports it
//! closed. The outcome is logged by domain.
//!
//! Launching never changes the server's run policy: a server that isn't
//! launchable answers at once, and the base waits for it to become so.
//! Every failure answers as `{kind, message}`, a [`LaunchError`].

use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_page_browser::{BrowserEvent, NativePageBrowserExt, OpenRequest};
use url::Url;
use wildflowerhealthio_gatekeeper::domain::gatekeeper_error::GatekeeperError;
use wildflowerhealthio_servers::{
    LaunchError, RegistryError, ServerDetail, ServerLaunchMinter, ServerRecord, ServerRegistry,
    ServerStatus,
};
use wildflowerhealthio_tauri_unit_runner::{UnitId, UnitStatus, UnitStatuses};

use crate::server_status::certificate_state;
use crate::{ServerUnits, ServersState};

/// Open the server `domain`'s launcher as a SMART EHR launch against it, with
/// a launch minted for any client, in the in-app browser. Invoked as
/// `invoke('server_launch', { domain })`; answers with nothing once the
/// browser is opening it.
///
/// # Errors
///
/// The [`LaunchError`] that stopped it: the server isn't registered, isn't
/// launchable now, or its gatekeeper or the in-app browser failed.
#[tauri::command]
pub async fn server_launch(
    app: AppHandle,
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<(), LaunchError> {
    launch(
        Arc::clone(&servers.registry),
        &servers.data_root,
        &servers.server_units.statuses(),
        domain,
        NativePageLaunchBrowser { app },
        servers.server_units.clone(),
    )
    .await
}

/// Called once a launch's in-app browser view is gone.
pub(crate) type LaunchViewClosed = Box<dyn Fn() + Send + Sync>;

/// Where launches open: in the app, the native-page browser plugin's in-app
/// browser; in the tests, a record of what was opened.
pub(crate) trait LaunchBrowser: Send + Sync + 'static {
    /// Open `launch_url` in a view of the in-app browser. A view already
    /// showing is replaced on iOS; on Android, where only a view still opening
    /// can show while the app is in front, the open joins that view instead of
    /// opening `launch_url`. `view_closed` is called once the view is gone: the
    /// user closed it, or, on iOS, a later open replaced it. It never is on a
    /// desktop, whose view is a default-browser tab, nor after an error.
    ///
    /// # Errors
    ///
    /// [`LaunchError::OpeningLauncher`] when the view couldn't be opened,
    /// including an Android open refused while the app isn't in front.
    fn open(
        &self,
        launch_url: Url,
        view_closed: LaunchViewClosed,
    ) -> impl Future<Output = Result<(), LaunchError>> + Send;
}

/// Hears each launch's in-app browser view open and close, so an open view
/// counts toward the `WhileOpen` run policy: in the app, the servers' units;
/// in the tests, a record of the views open.
pub(crate) trait LaunchPresence: Clone + Send + Sync + 'static {
    /// The launch view `view` opened.
    fn view_opened(&self, view: &str);
    /// The launch view `view` closed.
    fn view_closed(&self, view: &str);
}

impl LaunchPresence for ServerUnits {
    fn view_opened(&self, view: &str) {
        self.launch_view_opened(view);
    }

    fn view_closed(&self, view: &str) {
        self.launch_view_closed(view);
    }
}

/// Open the server `domain`'s launcher in `launch_browser`, once the server's
/// status in `statuses`, with its certificate state (its run's, or what its
/// cache in `data_root` says), is launchable, and tell `launch_presence` its
/// view is open until the browser reports it closed.
async fn launch(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    launch_browser: impl LaunchBrowser,
    launch_presence: impl LaunchPresence,
) -> Result<(), LaunchError> {
    let result = async {
        let record = registered_record(registry, domain.clone()).await?;
        // A server the unit runner doesn't hold has never run.
        let unit_status = statuses
            .get(&UnitId::new(&domain))
            .cloned()
            .unwrap_or_else(UnitStatus::never_run);
        let status = ServerStatus {
            domain: domain.clone(),
            certificate: certificate_state(data_root, &record, &unit_status).await,
            unit_status,
        };
        let launch_minter = ServerLaunchMinter::of_launchable_server(&status)?;
        let launch = tokio::task::spawn_blocking(move || launch_minter.mint())
            .await
            .map_err(|error| {
                LaunchError::Gatekeeper(GatekeeperError::infrastructure("minting a launch", error))
            })??;
        let launch_url = wildflowerhealthio_servers::launch_url(
            &record.launcher_url,
            &record.public_origin(),
            &launch,
        );
        open_launch_view(&launch_browser, launch_presence, launch_url).await
    }
    .await;
    match &result {
        Ok(()) => log::info!("[servers] launched the launcher of {domain}"),
        Err(error) => log::warn!("[servers] launching the launcher of {domain} failed: {error}"),
    }
    result
}

/// Open `launch_url` in a new view of `launch_browser`, open in
/// `launch_presence` from before the open until the browser reports the view
/// closed, or the open fails.
async fn open_launch_view(
    launch_browser: &impl LaunchBrowser,
    launch_presence: impl LaunchPresence,
    launch_url: Url,
) -> Result<(), LaunchError> {
    let view = next_launch_view();
    // Before the open, so a close reported as the view opens finds it.
    launch_presence.view_opened(&view);
    let view_closed: LaunchViewClosed = {
        let launch_presence = launch_presence.clone();
        let view = view.clone();
        Box::new(move || launch_presence.view_closed(&view))
    };
    let opened = launch_browser.open(launch_url, view_closed).await;
    if opened.is_err() {
        launch_presence.view_closed(&view);
    }
    opened
}

/// A new launch view's id, `launch-<n>`: one per open, so a view a later
/// launch replaces (iOS), whose close is reported after the new view opened,
/// closes under its own.
fn next_launch_view() -> String {
    static LAUNCH_VIEWS_OPENED: AtomicU64 = AtomicU64::new(0);
    format!(
        "launch-{}",
        LAUNCH_VIEWS_OPENED.fetch_add(1, Ordering::Relaxed)
    )
}

/// The record of the server `domain`, as `servers.json` holds it, read on a
/// blocking thread.
async fn registered_record(
    registry: Arc<dyn ServerRegistry>,
    domain: String,
) -> Result<ServerRecord, LaunchError> {
    tokio::task::spawn_blocking(move || registry.read(&domain))
        .await
        .map_err(|error| RegistryError::storage("reading a server's launcher", error))?
        .map_err(LaunchError::from)
}

/// The app's in-app browser: the native-page browser plugin, which a launch
/// can't script. On iOS it is an `SFSafariViewController`, on Android a Custom
/// Tab, each presented as a native page, and on a desktop the default browser.
struct NativePageLaunchBrowser {
    app: AppHandle,
}

impl LaunchBrowser for NativePageLaunchBrowser {
    async fn open(
        &self,
        launch_url: Url,
        view_closed: LaunchViewClosed,
    ) -> Result<(), LaunchError> {
        let closed = Channel::new(move |body| {
            match body.deserialize()? {
                BrowserEvent::Closed => view_closed(),
            }
            Ok(())
        });
        self.app
            .native_page_browser()
            .open(OpenRequest {
                url: launch_url.to_string(),
                closed,
            })
            .await
            .map_err(|error| LaunchError::OpeningLauncher {
                reason: error.to_string(),
            })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    use wildflowerhealthio_rathole_settings::TunnelName;
    use wildflowerhealthio_servers::{
        CertificateAuthority, JsonServerRegistry, RelayKind, RunPolicy, ServerRecord, TunnelToken,
    };
    use wildflowerhealthio_shared_structures::health_check::HealthReport;
    use wildflowerhealthio_tauri_unit_runner::RunState;
    use wildflowerhealthio_tunnel::TunnelState;
    use wildflowerhealthio_wildflower_server::{CertificateState, CertificateStatus, ServerHealth};

    use super::*;
    use crate::test_gatekeeper::{test_gatekeeper, TestGatekeeper, DOMAIN};

    const LAUNCHER: &str = "https://launcher.example/app?theme=dark";

    /// What an [`OneViewBrowser`] does with an open while a view shows.
    #[derive(Clone, Copy)]
    enum WhileAViewShows {
        /// iOS: report the showing view closed, then show the new one.
        Replace,
        /// Android: join the showing view, which is still opening, so its
        /// close reports for both opens.
        Join,
    }

    /// An in-app browser that shows one view at a time, as a phone's does.
    #[derive(Clone)]
    struct OneViewBrowser {
        while_a_view_shows: WhileAViewShows,
        views: Arc<Mutex<BrowserViews>>,
    }

    /// Each launch URL a [`OneViewBrowser`] opened, and how its showing view
    /// reports its close: once for each open that opened or joined it, none
    /// while no view shows.
    #[derive(Default)]
    struct BrowserViews {
        opened: Vec<Url>,
        showing: Vec<LaunchViewClosed>,
    }

    impl OneViewBrowser {
        /// A browser that does `while_a_view_shows` with an open while a view
        /// shows.
        fn new(while_a_view_shows: WhileAViewShows) -> Self {
            Self {
                while_a_view_shows,
                views: Arc::default(),
            }
        }

        /// Each launch URL opened, in order.
        fn opened(&self) -> Vec<Url> {
            self.views.lock().unwrap().opened.clone()
        }

        /// The user closes the showing view.
        fn close_showing(&self) {
            let showing = std::mem::take(&mut self.views.lock().unwrap().showing);
            assert!(!showing.is_empty(), "a view is showing");
            for view_closed in showing {
                view_closed();
            }
        }
    }

    impl LaunchBrowser for OneViewBrowser {
        async fn open(
            &self,
            launch_url: Url,
            view_closed: LaunchViewClosed,
        ) -> Result<(), LaunchError> {
            let replaced = {
                let mut views = self.views.lock().unwrap();
                if !views.showing.is_empty() {
                    if let WhileAViewShows::Join = self.while_a_view_shows {
                        views.showing.push(view_closed);
                        return Ok(());
                    }
                }
                views.opened.push(launch_url);
                std::mem::replace(&mut views.showing, vec![view_closed])
            };
            for replaced_view_closed in replaced {
                replaced_view_closed();
            }
            Ok(())
        }
    }

    /// An in-app browser that can't open anything.
    struct FailingBrowser;

    impl LaunchBrowser for FailingBrowser {
        async fn open(&self, _: Url, _: LaunchViewClosed) -> Result<(), LaunchError> {
            Err(LaunchError::OpeningLauncher {
                reason: "no browser".to_owned(),
            })
        }
    }

    /// The launch views open, as a [`LaunchPresence`] hears them.
    #[derive(Clone, Default)]
    struct OpenLaunchViews(Arc<Mutex<BTreeSet<String>>>);

    impl OpenLaunchViews {
        fn views(&self) -> BTreeSet<String> {
            self.0.lock().unwrap().clone()
        }
    }

    impl LaunchPresence for OpenLaunchViews {
        fn view_opened(&self, view: &str) {
            assert!(self.0.lock().unwrap().insert(view.to_owned()), "{view}");
        }

        fn view_closed(&self, view: &str) {
            assert!(self.0.lock().unwrap().remove(view), "{view}");
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

    /// A change to a launchable run's detail.
    type DetailChange = fn(&mut ServerDetail);

    /// The servers' statuses with the server's run up over `gatekeeper`,
    /// connected to and reachable through its relay, with a valid certificate
    /// from Let's Encrypt, changed by `change`.
    fn running_with(
        gatekeeper: &TestGatekeeper,
        change: impl FnOnce(&mut ServerDetail),
    ) -> UnitStatuses<ServerDetail> {
        let mut detail = ServerDetail {
            health: Some(ServerHealth::Reachable(HealthReport::pass())),
            tunnel: Some(TunnelState::Connected),
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
        change(&mut detail);
        let status = UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: Some(detail),
        };
        [(UnitId::new(DOMAIN), status)].into()
    }

    /// The servers' statuses with the server launchable over `gatekeeper`.
    fn launchable(gatekeeper: &TestGatekeeper) -> UnitStatuses<ServerDetail> {
        running_with(gatekeeper, |_| {})
    }

    /// Launch the server [`DOMAIN`], launchable over `gatekeeper`, in
    /// `browser`, with `presence` hearing its view.
    async fn launch_launchable(
        gatekeeper: &TestGatekeeper,
        browser: impl LaunchBrowser,
        presence: &OpenLaunchViews,
    ) -> Result<(), LaunchError> {
        let (data_root, registry) = registry();
        launch(
            registry,
            data_root.path(),
            &launchable(gatekeeper),
            DOMAIN.to_owned(),
            browser,
            presence.clone(),
        )
        .await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launchable_server_s_launcher_opens_at_its_launch_url() {
        let gatekeeper = test_gatekeeper();
        let browser = OneViewBrowser::new(WhileAViewShows::Replace);
        let presence = OpenLaunchViews::default();

        launch_launchable(&gatekeeper, browser.clone(), &presence)
            .await
            .unwrap();

        let opened = browser.opened();
        let [launch_url] = opened.as_slice() else {
            panic!("one launcher opens: {opened:?}");
        };
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
        assert_eq!(gatekeeper.minted_launches(), 1);
        assert_eq!(presence.views().len(), 1, "its view is open");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_a_launch_s_view_ends_its_presence() {
        let gatekeeper = test_gatekeeper();
        let browser = OneViewBrowser::new(WhileAViewShows::Replace);
        let presence = OpenLaunchViews::default();
        launch_launchable(&gatekeeper, browser.clone(), &presence)
            .await
            .unwrap();

        browser.close_showing();

        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_ios_a_second_launch_replaces_the_first_s_view() {
        let gatekeeper = test_gatekeeper();
        let browser = OneViewBrowser::new(WhileAViewShows::Replace);
        let presence = OpenLaunchViews::default();
        launch_launchable(&gatekeeper, browser.clone(), &presence)
            .await
            .unwrap();
        let first_views = presence.views();

        launch_launchable(&gatekeeper, browser.clone(), &presence)
            .await
            .unwrap();

        let opened = browser.opened();
        assert_eq!(opened.len(), 2);
        assert_ne!(opened[0], opened[1], "each launch is minted afresh");
        let second_views = presence.views();
        assert_eq!(second_views.len(), 1, "only the second view is open");
        assert!(second_views.is_disjoint(&first_views));
        browser.close_showing();
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_android_a_second_launch_while_the_first_s_view_opens_joins_it() {
        let gatekeeper = test_gatekeeper();
        let browser = OneViewBrowser::new(WhileAViewShows::Join);
        let presence = OpenLaunchViews::default();
        launch_launchable(&gatekeeper, browser.clone(), &presence)
            .await
            .unwrap();
        let first_views = presence.views();

        launch_launchable(&gatekeeper, browser.clone(), &presence)
            .await
            .unwrap();

        assert_eq!(browser.opened().len(), 1, "no second view opens");
        let second_views = presence.views();
        assert_eq!(second_views.len(), 2, "both launches' views are open");
        assert!(second_views.is_superset(&first_views));
        browser.close_showing();
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launch_the_browser_can_t_open_leaves_no_view_open() {
        let gatekeeper = test_gatekeeper();
        let presence = OpenLaunchViews::default();

        let failed = launch_launchable(&gatekeeper, FailingBrowser, &presence).await;

        assert_eq!(failed.map_err(|error| error.kind()), Err("openingLauncher"));
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_running_server_the_status_refuses_opens_nothing_and_mints_nothing() {
        let unreachable = |detail: &mut ServerDetail| {
            detail.health = Some(ServerHealth::Unreachable {
                error: "the relay answered 502".to_owned(),
            });
        };
        let ordering = |detail: &mut ServerDetail| {
            detail.certificate.as_mut().unwrap().status = CertificateStatus::Ordering;
        };
        let on_staging = |detail: &mut ServerDetail| {
            detail.certificate.as_mut().unwrap().issuer = CertificateAuthority::LetsEncryptStaging;
        };
        let token_rejected = |detail: &mut ServerDetail| {
            detail.tunnel = Some(TunnelState::TokenRejected);
        };
        let tunnel_unknown = |detail: &mut ServerDetail| {
            detail.tunnel = Some(TunnelState::TunnelUnknown);
        };
        let changes: [(&str, DetailChange); 5] = [
            ("unreachable", unreachable),
            ("tokenRejected", token_rejected),
            ("tunnelUnknown", tunnel_unknown),
            ("noValidCertificate", ordering),
            ("untrustedCertificate", on_staging),
        ];
        for (kind, change) in changes {
            let gatekeeper = test_gatekeeper();
            let (data_root, registry) = registry();
            let browser = OneViewBrowser::new(WhileAViewShows::Replace);
            let presence = OpenLaunchViews::default();

            let refused = launch(
                registry,
                data_root.path(),
                &running_with(&gatekeeper, change),
                DOMAIN.to_owned(),
                browser.clone(),
                presence.clone(),
            )
            .await;

            assert_eq!(refused.map_err(|error| error.kind()), Err(kind));
            assert!(browser.opened().is_empty(), "{kind}");
            assert!(presence.views().is_empty(), "{kind}");
            assert_eq!(gatekeeper.minted_launches(), 0, "{kind}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_isn_t_launchable_opens_nothing() {
        let (data_root, registry) = registry();
        let browser = OneViewBrowser::new(WhileAViewShows::Replace);
        let presence = OpenLaunchViews::default();
        let not_running: UnitStatuses<ServerDetail> =
            [(UnitId::new(DOMAIN), UnitStatus::never_run())].into();

        let refused = launch(
            registry,
            data_root.path(),
            &not_running,
            DOMAIN.to_owned(),
            browser.clone(),
            presence.clone(),
        )
        .await;

        assert!(
            matches!(refused, Err(LaunchError::ServerNotRunning { .. })),
            "{refused:?}"
        );
        assert!(browser.opened().is_empty());
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_isn_t_registered_is_refused() {
        let gatekeeper = test_gatekeeper();
        let (data_root, registry) = registry();
        let browser = OneViewBrowser::new(WhileAViewShows::Replace);
        let presence = OpenLaunchViews::default();

        let refused = launch(
            registry,
            data_root.path(),
            &launchable(&gatekeeper),
            "lab.relay.example.com".to_owned(),
            browser.clone(),
            presence.clone(),
        )
        .await;

        assert_eq!(refused.map_err(|error| error.kind()), Err("notRegistered"));
        assert!(browser.opened().is_empty());
        assert!(presence.views().is_empty());
    }
}
