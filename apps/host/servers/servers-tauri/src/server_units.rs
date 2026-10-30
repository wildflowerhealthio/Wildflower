//! [`ServerUnits`]: the one place a server's record becomes a unit on the
//! unit runner, the way the servers commands change and read the servers'
//! units, how a launch's in-app browser view counts toward their
//! `WhileOpen` run policy, the sign-in codes those views were opened with,
//! the consents showing in them, the consent opens waiting for their server,
//! and the taps on consent notifications.

use std::sync::Arc;

use tokio::sync::watch;
use wildflowerhealthio_authorization_server::SameDeviceSignInCode;
use wildflowerhealthio_servers::{
    ConsentViews, LaunchViewSignIns, ServerDetail, ServerRecord, ServerSignInCodeMinter, ServerUnit,
};
use wildflowerhealthio_tauri_unit_runner::{RunPolicy, TauriUnitRunner, UnitId, UnitStatuses};
use wildflowerhealthio_wildflower_server::WildflowerServerConfig;

use crate::waiting_consent_opens::WaitingConsentOpens;

/// Builds the config a server's run reads from its record: what the host
/// derives at build time, from its platform paths and from the record. Called
/// at the start of every run of the server, so a failure is a failed run.
pub type ServerConfigBuilder =
    Arc<dyn Fn(&ServerRecord) -> anyhow::Result<WildflowerServerConfig> + Send + Sync>;

/// Pushes the install's servers to `TauriUnitRunner`, each as a unit whose id
/// is the server's domain, and reads their statuses back.
#[derive(Clone)]
pub struct ServerUnits {
    runner: TauriUnitRunner<ServerDetail>,
    server_config: ServerConfigBuilder,
    /// The sign-in codes of each server's launch views, until its last one
    /// closes, which a run keeps the sessions of as it starts.
    launch_view_sign_ins: LaunchViewSignIns<SameDeviceSignInCode>,
    /// The consents showing in a launch view, shared by every way one opens.
    consent_views: ConsentViews,
    /// The consent opens waiting for their server, shared by every way one
    /// opens.
    waiting_consent_opens: WaitingConsentOpens,
    /// How many consent notifications have been tapped.
    notification_taps: Arc<watch::Sender<u64>>,
}

impl ServerUnits {
    /// Server units on `runner`, whose runs read the config `server_config`
    /// builds.
    #[must_use]
    pub fn new(runner: TauriUnitRunner<ServerDetail>, server_config: ServerConfigBuilder) -> Self {
        Self {
            runner,
            server_config,
            launch_view_sign_ins: LaunchViewSignIns::default(),
            consent_views: ConsentViews::default(),
            waiting_consent_opens: WaitingConsentOpens::default(),
            notification_taps: Arc::new(watch::Sender::new(0)),
        }
    }

    /// Set the server `record` describes on `TauriUnitRunner`, with its run
    /// policy and a factory that builds a fresh [`ServerUnit`] for each run
    /// from `record`, keeping the Owner sessions of the server's launch views
    /// still open as it starts. A server already set is replaced: a run of its
    /// old record stops, and it starts again from `record` if its policy wants
    /// it running.
    ///
    /// Call it after every registry write that changes `record`.
    pub fn push(&self, record: ServerRecord) {
        let unit_id = UnitId::new(record.domain());
        let run_policy = record.run_policy;
        let server_config = Arc::clone(&self.server_config);
        let launch_view_sign_ins = self.launch_view_sign_ins.clone();
        self.runner.set_unit(unit_id, run_policy, move || {
            Ok(ServerUnit::new(
                server_config(&record)?,
                launch_view_sign_ins.kept_at_run_start(&record.domain()),
            ))
        });
    }

    /// Give the server `domain` the run policy `run_policy` on
    /// `TauriUnitRunner`, keeping the record it was last pushed with. Even
    /// with the policy it already has, a pending restart is cancelled and the
    /// server starts at once if it should run.
    ///
    /// Call it after every registry write that changes only the server's run
    /// policy, when the server is set (see [`Self::holds`]); push a server that
    /// isn't.
    pub fn set_run_policy(&self, domain: &str, run_policy: RunPolicy) {
        self.runner
            .set_unit_policy(&UnitId::new(domain), run_policy);
    }

    /// Whether the server `domain` is set on `TauriUnitRunner`. It isn't when
    /// `servers.json` was unreadable at launch, or a failed removal couldn't
    /// read it to put the server back.
    #[must_use]
    pub fn holds(&self, domain: &str) -> bool {
        self.runner.statuses().contains_key(&UnitId::new(domain))
    }

    /// Stop the server `domain`, wait for its run to end, and take it off
    /// `TauriUnitRunner`, its status included.
    ///
    /// Call it before deleting the server's folder.
    pub async fn remove(&self, domain: &str) {
        self.runner.remove_unit(&UnitId::new(domain)).await;
    }

    /// Every server's status on `TauriUnitRunner`, keyed by domain.
    #[must_use]
    pub fn statuses(&self) -> UnitStatuses<ServerDetail> {
        self.runner.statuses()
    }

    /// Every server's status on `TauriUnitRunner`, keyed by domain, as it
    /// changes.
    #[must_use]
    pub fn subscribe_statuses(&self) -> watch::Receiver<UnitStatuses<ServerDetail>> {
        self.runner.subscribe()
    }

    /// A launch opened in the in-app browser view `view`. While it is open, it
    /// keeps the app present for the servers' `WhileOpen` run policy where the
    /// view moves the app to the background.
    pub fn launch_view_opened(&self, view: &str) {
        self.runner.browser_view_opened(view);
    }

    /// The browser of the in-app browser view `view`, a launch's, keeps the app
    /// alive under it, so the servers need no background session for it.
    pub fn launch_view_kept_alive(&self, view: &str) {
        self.runner.browser_view_kept_alive(view);
    }

    /// The in-app browser view `view`, a launch's, closed.
    pub fn launch_view_closed(&self, view: &str) {
        self.runner.browser_view_closed(view);
    }

    /// The app went fully to the background with the in-app browser view
    /// `view`, a launch's, over it (Android).
    pub fn launch_view_moved_to_background(&self, view: &str) {
        self.runner.browser_view_moved_to_background(view);
    }

    /// The app came back from fully in the background with the in-app
    /// browser view `view`, a launch's, still over it (Android).
    pub fn launch_view_returned_to_foreground(&self, view: &str) {
        self.runner.browser_view_returned_to_foreground(view);
    }

    /// The sign-in codes of each server's launch views, until its last one
    /// closes.
    pub(crate) fn launch_view_sign_ins(&self) -> &LaunchViewSignIns<SameDeviceSignInCode> {
        &self.launch_view_sign_ins
    }

    /// The sign-in code minter of the server `domain`'s run, while one is up.
    pub(crate) fn running_sign_in_code_minter(
        &self,
        domain: &str,
    ) -> Option<ServerSignInCodeMinter> {
        // Borrowed from the statuses' channel, so only this server's minter
        // is cloned, not every server's status.
        self.runner
            .subscribe()
            .borrow()
            .get(&UnitId::new(domain))?
            .detail
            .as_ref()?
            .sign_in_code_minter
            .clone()
    }

    /// The consents showing in a launch view, or opening in one, so each
    /// shows in one view however many ways open it at once.
    pub(crate) fn consent_views(&self) -> &ConsentViews {
        &self.consent_views
    }

    /// The consent opens waiting for their server, at most one per server.
    pub(crate) fn waiting_consent_opens(&self) -> &WaitingConsentOpens {
        &self.waiting_consent_opens
    }

    /// A consent notification was tapped: the consent notifications hear it
    /// through [`Self::subscribe_notification_taps`].
    pub(crate) fn notification_tapped(&self) {
        self.notification_taps.send_modify(|taps| *taps += 1);
    }

    /// How many consent notifications have been tapped, as it changes.
    pub(crate) fn subscribe_notification_taps(&self) -> watch::Receiver<u64> {
        self.notification_taps.subscribe()
    }
}
