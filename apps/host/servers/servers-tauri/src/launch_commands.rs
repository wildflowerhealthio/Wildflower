//! The launch commands: the base opens a server's launcher, an app, as a SMART
//! EHR launch against the server, the server's Wildflower Authorization
//! app, or the newest consent waiting on the server, each signed in as the
//! Owner. The launcher's and the Authorization
//! app's URLs come from the server's record; the server must be launchable
//! now, by the status the base receives
//! ([`ensure_launchable`](wildflowerhealthio_servers::ensure_launchable)). For
//! a launch, its run's authorization server mints a launch for any client on
//! a blocking thread ([`ServerLaunchMinter`]), for the launcher to open at
//! [`launch_url`](wildflowerhealthio_servers::launch_url); the Authorization
//! app opens at
//! [`authorization_app_url`](wildflowerhealthio_servers::authorization_app_url).
//! Either opens through the server's `/oauth/sign-in`, at
//! [`sign_in_url`](wildflowerhealthio_servers::sign_in_url) with a one-time
//! code the same authorization server mints ([`ServerSignInCodeMinter`]),
//! which signs the browser in as the Owner and sends it on, so the launch's
//! own sign-in reaches the server's consent card. A consent asked from
//! another browser or device opens the same way at its page, with `then=back`
//! ([`consent_sign_in_url`](wildflowerhealthio_servers::consent_sign_in_url)),
//! once the server is launchable: from the server's page in the base, from a
//! tap on its notification on a phone, at the app's start or a return to the
//! foreground on a phone, or, on a desktop, which reports no taps, as its
//! notification posts. Each consent shows in one view ([`ConsentViews`]), as
//! a tap and the return it brings both open it.
//!
//! All open in the in-app browser, [`LaunchBrowser`]. A launch and the
//! Authorization app replace the views showing: on iOS an open replaces the
//! views earlier ones opened, and on Android an open that arrives while an
//! earlier replacing one's view is still opening joins that view. A consent stacks over
//! them instead, so the page under it, as an app's waiting for that consent,
//! stays where it was: on iOS it shows over the top-most view, and on Android
//! it opens a Custom Tab of its own. On iOS the base closes the consent's
//! view once its request is decided or expires, as the run's
//! [`ServerConsentWatcher`] says, which reveals the page under it; a Custom
//! Tab and a desktop's default-browser tab can't be closed by the app. While
//! a view is open it counts toward the `WhileOpen` run policy
//! ([`LaunchPresence`]), until the browser reports it closed; on Android, a
//! background session keeps the app alive under it until the browser reports
//! it keeps the app alive itself. Each such view is a launch view, whichever
//! page it opened. The outcome is logged by domain.
//!
//! Opening any never changes the server's run policy: a server that isn't
//! launchable answers at once, and the base waits for it to become so.
//! Every failure answers as `{kind, message}`, a [`LaunchError`].

use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_page_browser::{
    BrowserEvent, CloseRequest, NativePageBrowserExt, OpenMode, OpenRequest,
};
use tokio::sync::{watch, Notify};
use url::Url;
use wildflowerhealthio_authorization_server::domain::authorization_server_error::AuthorizationServerError;
use wildflowerhealthio_servers::{
    ConsentKey, ConsentViewClaim, ConsentViews, IfShowing, LaunchError, ListedServer,
    PendingConsent, RegistryError, ServerConsentWatcher, ServerDetail, ServerLaunchMinter,
    ServerRecord, ServerRegistry, ServerSignInCodeMinter,
};
use wildflowerhealthio_tauri_unit_runner::{UnitId, UnitStatus, UnitStatuses};

use crate::server_status::certificate_state;
use crate::{ServerUnits, ServersState};

/// Open the server `domain`'s launcher as a SMART EHR launch against it, with
/// a launch minted for any client, in the in-app browser, signed in as the
/// Owner first. Invoked as `invoke('server_launch', { domain })`; answers with
/// nothing once the browser is opening it.
///
/// # Errors
///
/// The [`LaunchError`] that stopped it: the server isn't registered, isn't
/// launchable now, or its authorization server or the in-app browser failed.
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

/// Open the server `domain`'s Wildflower Authorization app, pointed at the
/// server, in the in-app browser, signed in as the Owner first. Invoked as
/// `invoke('server_open_authorization_app', { domain })`; answers with
/// nothing once the browser is opening it.
///
/// # Errors
///
/// The [`LaunchError`] that stopped it: the server isn't registered, isn't
/// launchable now, or the in-app browser failed.
#[tauri::command]
pub async fn server_open_authorization_app(
    app: AppHandle,
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<(), LaunchError> {
    open_authorization_app(
        Arc::clone(&servers.registry),
        &servers.data_root,
        &servers.server_units.statuses(),
        domain,
        NativePageLaunchBrowser { app },
        servers.server_units.clone(),
    )
    .await
}

/// Open the newest consent waiting on the server `domain` at its page, signed
/// in as the Owner first, in the in-app browser, over the views showing: the
/// server's pending request on its page in the base. Invoked as
/// `invoke('server_open_pending_consent', { domain })`; answers with nothing
/// once the browser is opening it. It opens even while a view of the same
/// request shows, as a desktop's tab the Owner closed, which the base doesn't
/// hear. On iOS its view closes once the request is decided or expires.
///
/// # Errors
///
/// The [`LaunchError`] that stopped it: the server isn't registered, isn't
/// launchable now, or has no consent waiting; or the in-app browser failed.
#[tauri::command]
pub async fn server_open_pending_consent(
    app: AppHandle,
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<(), LaunchError> {
    open_pending_consent(
        Arc::clone(&servers.registry),
        &servers.data_root,
        &servers.server_units.statuses(),
        domain,
        NativePageLaunchBrowser { app },
        servers.server_units.clone(),
        IfShowing::TakeOver,
    )
    .await
}

/// Open the consent a tapped notification announced, as
/// [`server_open_pending_consent`] opens a server's: the notification the
/// plugin posted under `notificationId`, as its tap reports it. Invoked as
/// `invoke('server_open_notified_consent', { notificationId })`; answers with
/// nothing, opening nothing, for a notification that isn't a consent's, or
/// for a consent already showing, as one the return to the foreground the
/// tap brought opened.
///
/// # Errors
///
/// As [`server_open_pending_consent`] for the server the notification is for.
#[tauri::command]
pub async fn server_open_notified_consent(
    app: AppHandle,
    servers: tauri::State<'_, ServersState>,
    notification_id: i32,
) -> Result<(), LaunchError> {
    let statuses = servers.server_units.statuses();
    let Some(domain) = wildflowerhealthio_servers::server_of_consent_notification(
        notification_id,
        statuses.keys().map(UnitId::as_str),
    ) else {
        return Ok(());
    };
    open_pending_consent(
        Arc::clone(&servers.registry),
        &servers.data_root,
        &statuses,
        domain.to_owned(),
        NativePageLaunchBrowser { app },
        servers.server_units.clone(),
        IfShowing::Skip,
    )
    .await
}

/// Open the consent `consent` waiting on the server `domain` in
/// `launch_browser`, as [`open_pending_consent`] does with the statuses
/// `statuses_rx` holds, now and on each change until it opens, while it is
/// still the server's newest request. Each try logs its outcome; a refusal
/// leaves the request at its notification and the server's page meanwhile.
///
/// Each request `consent_requests` opens, opens this way: on the desktop
/// each it notifies for, in the default browser, and on a phone the first a
/// server reports at the app's start, and one at each return to the
/// foreground. A consent already showing in a view, as one a tap on its
/// notification opened, opens in no other.
pub(crate) async fn open_consent_once_openable(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    mut statuses_rx: watch::Receiver<UnitStatuses<ServerDetail>>,
    domain: String,
    consent: &ConsentKey,
    launch_browser: impl LaunchBrowser + Clone,
    launch_presence: impl LaunchPresence,
) {
    loop {
        let statuses = statuses_rx.borrow_and_update().clone();
        let still_newest = statuses
            .get(&UnitId::new(&domain))
            .and_then(PendingConsent::of_run)
            .is_some_and(|newest| newest.key == *consent);
        if !still_newest {
            return;
        }
        let opened = open_pending_consent(
            Arc::clone(&registry),
            data_root,
            &statuses,
            domain.clone(),
            launch_browser.clone(),
            launch_presence.clone(),
            IfShowing::Skip,
        )
        .await;
        if opened.is_ok() || statuses_rx.changed().await.is_err() {
            return;
        }
    }
}

/// Who closes a view of an in-app browser, and whether the base hears it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ViewCloses {
    /// The base can close a view, and hears each close, the user's
    /// included: iOS's in-app browser, so the base closes a consent's view
    /// once its request is decided or expires, revealing the page under it.
    ByTheBaseOrTheUser,
    /// Only the user closes a view, and the base hears it: Android's Custom
    /// Tab, whose close is reported as the app resumes from under it. The
    /// page says the decision went through and the user leaves it.
    ByTheUserOnly,
    /// The base can't close a view, and never hears one close: a desktop's
    /// default-browser tab.
    Unheard,
}

/// Who closes a view of the in-app browser on this platform.
const NATIVE_PAGE_VIEW_CLOSES: ViewCloses = if cfg!(target_os = "ios") {
    ViewCloses::ByTheBaseOrTheUser
} else if cfg!(target_os = "android") {
    ViewCloses::ByTheUserOnly
} else {
    ViewCloses::Unheard
};

/// Hears a launch's in-app browser view's events: that its browser keeps the
/// app alive under it (Android), and that it is gone.
pub(crate) type LaunchViewEvents = Box<dyn Fn(BrowserEvent) + Send + Sync>;

/// Where launches open: in the app, the native-page browser plugin's in-app
/// browser; in the tests, a record of what was opened.
pub(crate) trait LaunchBrowser: Send + Sync + 'static {
    /// Open `url` in a view of the in-app browser named `view`, beside the
    /// views showing as `mode` says. [`OpenMode::Replace`] replaces them on
    /// iOS; on Android, where only a view still opening can show while the
    /// app is in front, it joins that view, when a replacing open opened it,
    /// instead of opening `url`.
    /// [`OpenMode::Stack`] shows over them on iOS, and opens a view of its
    /// own on Android. `view_events` hears [`BrowserEvent::Closed`] once the
    /// view is gone: the user closed it, or, on iOS, a later replacing open
    /// or a [`close`](Self::close) closed it; and, on Android,
    /// [`BrowserEvent::KeptAlive`] before that when the view's browser keeps
    /// the app alive under it. It hears nothing on a desktop, whose view is a
    /// default-browser tab, nor after an error.
    ///
    /// # Errors
    ///
    /// [`LaunchError::OpeningBrowser`] when the view couldn't be opened,
    /// including an Android open refused while the app isn't in front.
    fn open(
        &self,
        url: Url,
        view: &str,
        mode: OpenMode,
        view_events: LaunchViewEvents,
    ) -> impl Future<Output = Result<(), LaunchError>> + Send;

    /// Close the view opened as `view`, with any view shown over it, each
    /// hearing its [`BrowserEvent::Closed`]. A view already gone closes
    /// nothing.
    ///
    /// # Errors
    ///
    /// The plugin's, on Android and a desktop, which can't close a view, or
    /// on iOS while a view is still opening or closing.
    fn close(
        &self,
        view: &str,
    ) -> impl Future<Output = Result<(), tauri_plugin_native_page_browser::Error>> + Send;

    /// Who closes this browser's views, and whether the base hears it.
    fn view_closes(&self) -> ViewCloses;
}

/// Hears each launch's in-app browser view open and close, so an open view
/// counts toward the `WhileOpen` run policy, and holds the consents showing
/// in them: in the app, the servers' units; in the tests, a record of the
/// views open.
pub(crate) trait LaunchPresence: Clone + Send + Sync + 'static {
    /// The launch view `view` opened.
    fn view_opened(&self, view: &str);
    /// The browser of the launch view `view` keeps the app alive under it.
    fn view_kept_alive(&self, view: &str);
    /// The launch view `view` closed.
    fn view_closed(&self, view: &str);
    /// The consents showing in a launch view, or opening in one.
    fn consent_views(&self) -> &ConsentViews;
}

impl LaunchPresence for ServerUnits {
    fn view_opened(&self, view: &str) {
        self.launch_view_opened(view);
    }

    fn view_kept_alive(&self, view: &str) {
        self.launch_view_kept_alive(view);
    }

    fn view_closed(&self, view: &str) {
        self.launch_view_closed(view);
    }

    fn consent_views(&self) -> &ConsentViews {
        self.consent_views()
    }
}

/// Open the server `domain`'s launcher in `launch_browser`, signed in as the
/// Owner, once the server's status in `statuses`, with its certificate state
/// (its run's, or what its cache in `data_root` says), is launchable, and tell
/// `launch_presence` its view is open until the browser reports it closed.
async fn launch(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    launch_browser: impl LaunchBrowser,
    launch_presence: impl LaunchPresence,
) -> Result<(), LaunchError> {
    let result = async {
        let server = listed_server(registry, data_root, statuses, domain.clone()).await?;
        let launch_minter = ServerLaunchMinter::of_launchable_server(&server.status)?;
        let sign_in_code_minter = ServerSignInCodeMinter::of_launchable_server(&server.status)?;
        let launch = tokio::task::spawn_blocking(move || launch_minter.mint())
            .await
            .map_err(|error| {
                LaunchError::AuthorizationServer(AuthorizationServerError::infrastructure(
                    "minting a launch",
                    error,
                ))
            })??;
        let public_origin = server.record.public_origin();
        let launch_url = wildflowerhealthio_servers::launch_url(
            &server.record.launcher_url,
            &public_origin,
            &launch,
        );
        let sign_in_url = wildflowerhealthio_servers::sign_in_url(
            &public_origin,
            &sign_in_code_minter.mint(),
            launch_url.as_str(),
        );
        open_launch_view(
            &launch_browser,
            launch_presence,
            sign_in_url,
            OpenMode::Replace,
        )
        .await?;
        Ok(())
    }
    .await;
    match &result {
        Ok(()) => log::info!("[servers] launched the launcher of {domain}"),
        Err(error) => log::warn!("[servers] launching the launcher of {domain} failed: {error}"),
    }
    result
}

/// Open the server `domain`'s Authorization app in `launch_browser`, signed
/// in as the Owner, once the server's status in `statuses`, with its
/// certificate state (its run's, or what its cache in `data_root` says), is
/// launchable, and tell `launch_presence` its view is open until the browser
/// reports it closed, as a launch does.
async fn open_authorization_app(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    launch_browser: impl LaunchBrowser,
    launch_presence: impl LaunchPresence,
) -> Result<(), LaunchError> {
    let result = async {
        let server = listed_server(registry, data_root, statuses, domain.clone()).await?;
        let sign_in_code_minter = ServerSignInCodeMinter::of_launchable_server(&server.status)?;
        let public_origin = server.record.public_origin();
        let authorization_app_url = wildflowerhealthio_servers::authorization_app_url(
            &server.record.authorization_url,
            &public_origin,
        );
        let sign_in_url = wildflowerhealthio_servers::sign_in_url(
            &public_origin,
            &sign_in_code_minter.mint(),
            authorization_app_url.as_str(),
        );
        open_launch_view(
            &launch_browser,
            launch_presence,
            sign_in_url,
            OpenMode::Replace,
        )
        .await?;
        Ok(())
    }
    .await;
    match &result {
        Ok(()) => log::info!("[servers] opened the Authorization app of {domain}"),
        Err(error) => {
            log::warn!("[servers] opening the Authorization app of {domain} failed: {error}");
        }
    }
    result
}

/// Open the newest consent waiting on the server `domain` in `launch_browser`,
/// over the views showing, at its page, signed in as the Owner, once the
/// server's status in `statuses`, with its certificate state (its run's, or
/// what its cache in `data_root` says), is launchable, and tell
/// `launch_presence` its view is open until the browser reports it closed, as
/// a launch does. The consent shows in `launch_presence`'s [`ConsentViews`],
/// a consent showing there already opening as `if_showing` says, until its
/// view closes, where `launch_browser` reports closes; where the base can
/// close the view ([`ViewCloses::ByTheBaseOrTheUser`]), until the run's
/// [`ServerConsentWatcher`] says the request is decided or expired too,
/// closing the view then. Where no close is heard ([`ViewCloses::Unheard`]),
/// it shows only while its view opens.
async fn open_pending_consent(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    launch_browser: impl LaunchBrowser,
    launch_presence: impl LaunchPresence,
    if_showing: IfShowing,
) -> Result<(), LaunchError> {
    let result = async {
        let server = listed_server(registry, data_root, statuses, domain.clone()).await?;
        let sign_in_code_minter = ServerSignInCodeMinter::of_launchable_server(&server.status)?;
        let consent_watcher = ServerConsentWatcher::of_launchable_server(&server.status)?;
        let pending_consent =
            PendingConsent::of_run(&server.status.unit_status).ok_or_else(|| {
                LaunchError::NothingPending {
                    domain: domain.clone(),
                }
            })?;
        let Some(claim) =
            launch_presence
                .consent_views()
                .claim(&domain, &pending_consent.key, if_showing)
        else {
            return Ok(false);
        };
        let sign_in_url = wildflowerhealthio_servers::consent_sign_in_url(
            &server.record.public_origin(),
            &sign_in_code_minter.mint(),
            &pending_consent.key,
        );
        // A failed open drops the claim with the rest.
        let launch_view = open_launch_view(
            &launch_browser,
            launch_presence,
            sign_in_url,
            OpenMode::Stack,
        )
        .await?;
        match launch_browser.view_closes() {
            ViewCloses::ByTheBaseOrTheUser => {
                let settled =
                    async move { consent_watcher.until_settled(pending_consent.key).await };
                tokio::spawn(close_once_settled_view(
                    launch_browser,
                    settled,
                    launch_view,
                    domain.clone(),
                    claim,
                ));
            }
            ViewCloses::ByTheUserOnly => {
                tokio::spawn(async move {
                    launch_view.closed.notified().await;
                    drop(claim);
                });
            }
            // Nothing would end a wait for its close.
            ViewCloses::Unheard => drop(claim),
        }
        Ok(true)
    }
    .await;
    match &result {
        Ok(true) => log::info!("[servers] opened the consent waiting on {domain}"),
        Ok(false) => log::info!("[servers] the consent waiting on {domain} is showing already"),
        Err(error) => {
            log::warn!("[servers] opening the consent waiting on {domain} failed: {error}");
        }
    }
    result.map(|_opened| ())
}

/// Close `launch_view`, the view a consent on the server `domain` opened in,
/// in `launch_browser` once `settled`, the run's [`ServerConsentWatcher`]
/// waiting on the request, says it is decided or expired; stop waiting once
/// the view closes first, or the watch fails, as when the run ends under the
/// view. Then release `claim`, the view's in its [`ConsentViews`], so after a
/// failed watch a later open may show the request again. The outcome is
/// logged.
async fn close_once_settled_view(
    launch_browser: impl LaunchBrowser,
    settled: impl Future<Output = Result<(), AuthorizationServerError>> + Send,
    launch_view: LaunchView,
    domain: String,
    claim: ConsentViewClaim,
) {
    tokio::select! {
        settled = settled => match settled {
            Ok(()) => close_settled_view(&launch_browser, &launch_view.name, &domain).await,
            Err(error) => {
                log::warn!("[servers] watching the consent opened on {domain} failed: {error}");
            }
        },
        () = launch_view.closed.notified() => {}
    }
    drop(claim);
}

/// How many times the base tries to close a settled consent's view: iOS
/// refuses a close while a view is still opening or closing, which lasts a
/// moment.
const SETTLED_VIEW_CLOSE_TRIES: u32 = 8;

/// How long the base waits between tries to close a settled consent's view.
const SETTLED_VIEW_CLOSE_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Close `view`, a settled consent's on the server `domain`, in
/// `launch_browser`, trying again a few times while it refuses, as iOS does
/// while a view is still opening or closing. The outcome is logged.
async fn close_settled_view(launch_browser: &impl LaunchBrowser, view: &str, domain: &str) {
    for attempt in 1..=SETTLED_VIEW_CLOSE_TRIES {
        match launch_browser.close(view).await {
            Ok(()) => {
                log::info!("[servers] closed the settled consent's view on {domain}");
                return;
            }
            Err(error) if attempt < SETTLED_VIEW_CLOSE_TRIES => {
                log::debug!(
                    "[servers] closing the settled consent's view on {domain} failed, \
                     trying again: {error}"
                );
                tokio::time::sleep(SETTLED_VIEW_CLOSE_RETRY_DELAY).await;
            }
            Err(error) => log::warn!(
                "[servers] closing the settled consent's view on {domain} failed: {error}"
            ),
        }
    }
}

/// The server `domain` as `servers.json` holds it, with its status in
/// `statuses` and its certificate state: its run's, or what its cache in
/// `data_root` says.
async fn listed_server(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
) -> Result<ListedServer, LaunchError> {
    let record = registered_record(registry, domain.clone()).await?;
    // A server the unit runner doesn't hold has never run.
    let unit_status = statuses
        .get(&UnitId::new(&domain))
        .cloned()
        .unwrap_or_else(UnitStatus::never_run);
    let certificate = certificate_state(data_root, &record, &unit_status).await;
    Ok(ListedServer::new(record, unit_status, certificate))
}

/// Open `url` in a new view of `launch_browser`, beside the views showing as
/// `mode` says, open in `launch_presence` from before the open until the
/// browser reports the view closed, or the open fails, and kept alive there
/// once the browser reports that.
async fn open_launch_view(
    launch_browser: &impl LaunchBrowser,
    launch_presence: impl LaunchPresence,
    url: Url,
    mode: OpenMode,
) -> Result<LaunchView, LaunchError> {
    let view = next_launch_view();
    let closed = Arc::new(Notify::new());
    // Before the open, so a close reported as the view opens finds it, and
    // a background session can start while the app is still in front.
    launch_presence.view_opened(&view);
    let view_events: LaunchViewEvents = {
        let launch_presence = launch_presence.clone();
        let view = view.clone();
        let closed = Arc::clone(&closed);
        Box::new(move |event| match event {
            BrowserEvent::KeptAlive => launch_presence.view_kept_alive(&view),
            BrowserEvent::Closed => {
                launch_presence.view_closed(&view);
                closed.notify_one();
            }
        })
    };
    if let Err(error) = launch_browser.open(url, &view, mode, view_events).await {
        launch_presence.view_closed(&view);
        return Err(error);
    }
    Ok(LaunchView { name: view, closed })
}

/// A launch view the in-app browser opened: its name, which the browser
/// closes it by, and a notice of its close.
struct LaunchView {
    name: String,
    /// Notified, once, when the browser reports the view closed.
    closed: Arc<Notify>,
}

/// A new launch view's id, `launch-<n>`: one per open, so a view a later
/// open replaces (iOS), whose close is reported after the new view opened,
/// closes under its own. The in-app browser names the view by it too.
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
        .map_err(|error| RegistryError::storage("reading a server's record", error))?
        .map_err(LaunchError::from)
}

/// The app's in-app browser: the native-page browser plugin, which the page
/// it opens can't script. On iOS it is an `SFSafariViewController`, on
/// Android a Custom Tab, each presented as a native page, and on a desktop
/// the default browser.
#[derive(Clone)]
pub(crate) struct NativePageLaunchBrowser {
    pub(crate) app: AppHandle,
}

impl LaunchBrowser for NativePageLaunchBrowser {
    async fn open(
        &self,
        url: Url,
        view: &str,
        mode: OpenMode,
        view_events: LaunchViewEvents,
    ) -> Result<(), LaunchError> {
        let events = Channel::new(move |body| {
            view_events(body.deserialize()?);
            Ok(())
        });
        self.app
            .native_page_browser()
            .open(OpenRequest {
                url: url.to_string(),
                view: view.to_owned(),
                mode,
                events,
            })
            .await
            .map_err(|error| LaunchError::OpeningBrowser {
                reason: error.to_string(),
            })
    }

    async fn close(&self, view: &str) -> Result<(), tauri_plugin_native_page_browser::Error> {
        self.app
            .native_page_browser()
            .close(CloseRequest {
                view: view.to_owned(),
            })
            .await
    }

    fn view_closes(&self) -> ViewCloses {
        NATIVE_PAGE_VIEW_CLOSES
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Mutex;
    use std::time::Duration;

    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_rathole_settings::TunnelName;
    use wildflowerhealthio_servers::{
        CertificateAuthority, JsonServerRegistry, RelayKind, RunPolicy, ServerConsentWatcher,
        ServerRecord, ServerRunId, TunnelToken,
    };
    use wildflowerhealthio_shared_structures::health_check::HealthReport;
    use wildflowerhealthio_tauri_unit_runner::RunState;
    use wildflowerhealthio_tunnel::TunnelState;
    use wildflowerhealthio_wildflower_server::{CertificateState, CertificateStatus, ServerHealth};

    use super::*;
    use crate::test_authorization_server::{
        test_authorization_server, TestAuthorizationServer, DOMAIN,
    };

    const LAUNCHER: &str = "https://launcher.example/app?theme=dark";
    const AUTHORIZATION: &str = "https://authorization.example/app/?theme=dark";

    /// Which phone a [`PhoneBrowser`] browses as.
    #[derive(Clone, Copy)]
    enum Phone {
        /// A replacing open closes the showing views, top-most first, then
        /// shows its own; a stacking one shows over them; a close closes a
        /// view and the views over it.
        Ios,
        /// A replacing open joins the top-most showing view, still opening,
        /// that a replacing open opened, so its close reports for both opens;
        /// any other open opens its own. The base closes none.
        Android,
    }

    /// An in-app browser as a phone's shows its views.
    #[derive(Clone)]
    struct PhoneBrowser {
        phone: Phone,
        views: Arc<Mutex<BrowserViews>>,
    }

    /// Each URL a [`PhoneBrowser`] opened, the views showing, bottom first,
    /// and how many closes it refuses next, as iOS refuses one while a view is
    /// still opening or closing.
    #[derive(Default)]
    struct BrowserViews {
        opened: Vec<Url>,
        showing: Vec<ShowingView>,
        refused_closes: usize,
    }

    /// A view a [`PhoneBrowser`] shows: its name, and how it reports its
    /// events: once for each open that opened or joined it.
    struct ShowingView {
        name: String,
        events: Vec<LaunchViewEvents>,
        /// A stacking open opened it.
        stacked: bool,
    }

    impl ShowingView {
        fn report(&self, event: &BrowserEvent) {
            for view_events in &self.events {
                view_events(event.clone());
            }
        }
    }

    impl PhoneBrowser {
        /// A browser that shows its views as `phone`'s does.
        fn new(phone: Phone) -> Self {
            Self {
                phone,
                views: Arc::default(),
            }
        }

        /// Each URL opened, in order.
        fn opened(&self) -> Vec<Url> {
            self.views.lock().unwrap().opened.clone()
        }

        /// The names of the views showing, bottom first.
        fn showing(&self) -> Vec<String> {
            let views = self.views.lock().unwrap();
            views.showing.iter().map(|view| view.name.clone()).collect()
        }

        /// The top-most view's browser keeps the app alive under it.
        fn keep_top_alive(&self) {
            let views = self.views.lock().unwrap();
            let top = views.showing.last().expect("a view is showing");
            top.report(&BrowserEvent::KeptAlive);
        }

        /// The user closes the top-most view.
        fn close_top(&self) {
            let top = self.views.lock().unwrap().showing.pop();
            top.expect("a view is showing")
                .report(&BrowserEvent::Closed);
        }

        /// Close the views from `index` on, top-most first.
        fn close_from(&self, index: usize) {
            let closed: Vec<ShowingView> =
                self.views.lock().unwrap().showing.drain(index..).collect();
            for view in closed.iter().rev() {
                view.report(&BrowserEvent::Closed);
            }
        }
    }

    impl LaunchBrowser for PhoneBrowser {
        async fn open(
            &self,
            url: Url,
            view: &str,
            mode: OpenMode,
            view_events: LaunchViewEvents,
        ) -> Result<(), LaunchError> {
            {
                let mut views = self.views.lock().unwrap();
                if let (Phone::Android, OpenMode::Replace, Some(opening)) = (
                    self.phone,
                    mode,
                    views.showing.last_mut().filter(|opening| !opening.stacked),
                ) {
                    opening.events.push(view_events);
                    return Ok(());
                }
            }
            if let (Phone::Ios, OpenMode::Replace) = (self.phone, mode) {
                self.close_from(0);
            }
            let mut views = self.views.lock().unwrap();
            views.opened.push(url);
            views.showing.push(ShowingView {
                name: view.to_owned(),
                events: vec![view_events],
                stacked: mode == OpenMode::Stack,
            });
            Ok(())
        }

        async fn close(&self, view: &str) -> Result<(), tauri_plugin_native_page_browser::Error> {
            assert!(
                matches!(self.phone, Phone::Ios),
                "the base closes no Custom Tab"
            );
            {
                let mut views = self.views.lock().unwrap();
                if views.refused_closes > 0 {
                    views.refused_closes -= 1;
                    return Err(tauri_plugin_native_page_browser::Error::CloseDefaultBrowserTab);
                }
            }
            let index = self
                .views
                .lock()
                .unwrap()
                .showing
                .iter()
                .position(|showing| showing.name == view);
            if let Some(index) = index {
                self.close_from(index);
            }
            Ok(())
        }

        fn view_closes(&self) -> ViewCloses {
            match self.phone {
                Phone::Ios => ViewCloses::ByTheBaseOrTheUser,
                Phone::Android => ViewCloses::ByTheUserOnly,
            }
        }
    }

    /// An in-app browser that can't open anything.
    struct FailingBrowser;

    impl LaunchBrowser for FailingBrowser {
        async fn open(
            &self,
            _: Url,
            _: &str,
            _: OpenMode,
            _: LaunchViewEvents,
        ) -> Result<(), LaunchError> {
            Err(LaunchError::OpeningBrowser {
                reason: "no browser".to_owned(),
            })
        }

        async fn close(&self, _: &str) -> Result<(), tauri_plugin_native_page_browser::Error> {
            unreachable!("nothing opened, so nothing closes")
        }

        fn view_closes(&self) -> ViewCloses {
            ViewCloses::Unheard
        }
    }

    /// A desktop's default browser: each URL it opened, in a tab whose close
    /// it never reports, and which it can't close.
    #[derive(Clone, Default)]
    struct DesktopBrowser {
        opened: Arc<Mutex<Vec<Url>>>,
    }

    impl LaunchBrowser for DesktopBrowser {
        async fn open(
            &self,
            url: Url,
            _: &str,
            _: OpenMode,
            _: LaunchViewEvents,
        ) -> Result<(), LaunchError> {
            self.opened.lock().unwrap().push(url);
            Ok(())
        }

        async fn close(&self, _: &str) -> Result<(), tauri_plugin_native_page_browser::Error> {
            Err(tauri_plugin_native_page_browser::Error::CloseDefaultBrowserTab)
        }

        fn view_closes(&self) -> ViewCloses {
            ViewCloses::Unheard
        }
    }

    /// The launch views open, and those kept alive, as a [`LaunchPresence`]
    /// hears them, and the consents showing in them.
    #[derive(Clone, Default)]
    struct OpenLaunchViews {
        launch_views: Arc<Mutex<LaunchViews>>,
        consent_views: ConsentViews,
    }

    #[derive(Default)]
    struct LaunchViews {
        open: BTreeSet<String>,
        kept_alive: BTreeSet<String>,
    }

    impl OpenLaunchViews {
        fn views(&self) -> BTreeSet<String> {
            self.launch_views.lock().unwrap().open.clone()
        }

        fn kept_alive_views(&self) -> BTreeSet<String> {
            self.launch_views.lock().unwrap().kept_alive.clone()
        }
    }

    impl LaunchPresence for OpenLaunchViews {
        fn view_opened(&self, view: &str) {
            assert!(
                self.launch_views
                    .lock()
                    .unwrap()
                    .open
                    .insert(view.to_owned()),
                "{view}"
            );
        }

        fn view_kept_alive(&self, view: &str) {
            let mut views = self.launch_views.lock().unwrap();
            assert!(views.open.contains(view), "{view}");
            assert!(views.kept_alive.insert(view.to_owned()), "{view}");
        }

        fn view_closed(&self, view: &str) {
            let mut views = self.launch_views.lock().unwrap();
            assert!(views.open.remove(view), "{view}");
            views.kept_alive.remove(view);
        }

        fn consent_views(&self) -> &ConsentViews {
            &self.consent_views
        }
    }

    /// A registry in a fresh folder holding the server [`DOMAIN`], whose
    /// launcher is [`LAUNCHER`] and whose Authorization app is
    /// [`AUTHORIZATION`].
    fn registry() -> (tempfile::TempDir, Arc<dyn ServerRegistry>) {
        let data_root = tempfile::tempdir().unwrap();
        let registry = JsonServerRegistry::in_data_root(
            data_root.path(),
            Url::parse("https://wildflowerhealth.io/authorization/").unwrap(),
        );
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
            authorization_url: Url::parse(AUTHORIZATION).unwrap(),
            certificate_authority: CertificateAuthority::LetsEncrypt,
            run_policy: RunPolicy::WhileOpen,
        };
        assert_eq!(record.domain(), DOMAIN);
        registry.insert(Box::new(move |_| record)).unwrap();
        (data_root, Arc::new(registry))
    }

    /// A change to a launchable run's detail.
    type DetailChange = fn(&mut ServerDetail);

    /// The servers' statuses with the server's run up over `authorization_server`,
    /// connected to and reachable through its relay, with a valid certificate
    /// from Let's Encrypt, changed by `change`.
    fn running_with(
        authorization_server: &TestAuthorizationServer,
        change: impl FnOnce(&mut ServerDetail),
    ) -> UnitStatuses<ServerDetail> {
        let mut detail = ServerDetail {
            run: ServerRunId::next(),
            health: Some(ServerHealth::Reachable(HealthReport::pass())),
            tunnel: Some(TunnelState::Connected),
            certificate: Some(CertificateState {
                status: CertificateStatus::NoRenewalNeeded,
                issuer: CertificateAuthority::LetsEncrypt,
                held: None,
                last_error: None,
            }),
            pending_consent: None,
            launch_minter: Some(ServerLaunchMinter::new(
                authorization_server.launch_context_minter.clone(),
            )),
            sign_in_code_minter: Some(ServerSignInCodeMinter::new(
                authorization_server.same_device_sign_in_code_minter.clone(),
            )),
            consent_watcher: Some(ServerConsentWatcher::new(
                authorization_server.pending_consent_watcher.clone(),
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

    /// The servers' statuses with the server launchable over `authorization_server`.
    fn launchable(authorization_server: &TestAuthorizationServer) -> UnitStatuses<ServerDetail> {
        running_with(authorization_server, |_| {})
    }

    /// Launch the server [`DOMAIN`], launchable over `authorization_server`, in
    /// `browser`, with `presence` hearing its view.
    async fn launch_launchable(
        authorization_server: &TestAuthorizationServer,
        browser: impl LaunchBrowser,
        presence: &OpenLaunchViews,
    ) -> Result<(), LaunchError> {
        let (data_root, registry) = registry();
        launch(
            registry,
            data_root.path(),
            &launchable(authorization_server),
            DOMAIN.to_owned(),
            browser,
            presence.clone(),
        )
        .await
    }

    /// Open the Authorization app of the server [`DOMAIN`], launchable over
    /// `authorization_server`, in `browser`, with `presence` hearing its view.
    async fn open_launchable_authorization_app(
        authorization_server: &TestAuthorizationServer,
        browser: impl LaunchBrowser,
        presence: &OpenLaunchViews,
    ) -> Result<(), LaunchError> {
        let (data_root, registry) = registry();
        open_authorization_app(
            registry,
            data_root.path(),
            &launchable(authorization_server),
            DOMAIN.to_owned(),
            browser,
            presence.clone(),
        )
        .await
    }

    /// Where `opened`, the server [`DOMAIN`]'s `/oauth/sign-in` with a minted
    /// code, sends the browser once it has signed it in.
    fn next_after_sign_in(opened: &Url) -> Url {
        Url::parse(&next_of_sign_in(opened)).unwrap()
    }

    /// The `next` of `opened`, the server [`DOMAIN`]'s `/oauth/sign-in` with
    /// a minted code, as written.
    fn next_of_sign_in(opened: &Url) -> String {
        assert_eq!(
            opened.origin(),
            Url::parse(&format!("https://{DOMAIN}")).unwrap().origin()
        );
        assert_eq!(opened.path(), "/oauth/sign-in");
        let query: Vec<(String, String)> = opened
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        let [(code_name, code), (next_name, next)] = query.as_slice() else {
            panic!("a code and where to go next: {opened}");
        };
        assert_eq!(code_name, "code");
        assert!(!code.is_empty(), "a minted code: {opened}");
        assert_eq!(next_name, "next");
        next.clone()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launchable_server_s_launcher_opens_at_its_launch_url_through_the_sign_in() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();

        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();

        let opened = browser.opened();
        let [sign_in_url] = opened.as_slice() else {
            panic!("one launcher opens: {opened:?}");
        };
        let launch_url = next_after_sign_in(sign_in_url);
        assert_eq!(
            launch_url[..url::Position::AfterPath],
            *"https://launcher.example/app"
        );
        let query: Vec<(String, String)> = launch_url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(query[0], ("theme".to_owned(), "dark".to_owned()));
        assert_eq!(query[1], ("iss".to_owned(), format!("https://{DOMAIN}")));
        assert_eq!(query[2].0, "launch");
        assert!(!query[2].1.is_empty(), "a minted launch: {launch_url}");
        assert_eq!(authorization_server.minted_launches(), 1);
        assert_eq!(presence.views().len(), 1, "its view is open");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_a_launch_s_view_ends_its_presence() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();

        browser.close_top();

        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launch_view_its_browser_keeps_alive_is_kept_alive_until_it_closes() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Android);
        let presence = OpenLaunchViews::default();
        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();
        assert!(presence.kept_alive_views().is_empty());

        browser.keep_top_alive();

        assert_eq!(presence.kept_alive_views(), presence.views());
        browser.close_top();
        assert!(presence.views().is_empty());
        assert!(presence.kept_alive_views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_ios_a_second_launch_replaces_the_first_s_view() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();
        let first_views = presence.views();

        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();

        let opened = browser.opened();
        assert_eq!(opened.len(), 2);
        assert_ne!(
            next_after_sign_in(&opened[0]),
            next_after_sign_in(&opened[1]),
            "each launch is minted afresh"
        );
        let second_views = presence.views();
        assert_eq!(second_views.len(), 1, "only the second view is open");
        assert!(second_views.is_disjoint(&first_views));
        browser.close_top();
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_android_a_second_launch_while_the_first_s_view_opens_joins_it() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Android);
        let presence = OpenLaunchViews::default();
        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();
        let first_views = presence.views();

        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();

        assert_eq!(browser.opened().len(), 1, "no second view opens");
        let second_views = presence.views();
        assert_eq!(second_views.len(), 2, "both launches' views are open");
        assert!(second_views.is_superset(&first_views));
        browser.close_top();
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launch_the_browser_can_t_open_leaves_no_view_open() {
        let authorization_server = test_authorization_server();
        let presence = OpenLaunchViews::default();

        let failed = launch_launchable(&authorization_server, FailingBrowser, &presence).await;

        assert_eq!(failed.map_err(|error| error.kind()), Err("openingBrowser"));
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launchable_server_s_authorization_app_opens_pointed_at_it_through_the_sign_in() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();

        open_launchable_authorization_app(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();

        let opened = browser.opened();
        let [sign_in_url] = opened.as_slice() else {
            panic!("one Authorization app opens: {opened:?}");
        };
        assert_eq!(
            next_after_sign_in(sign_in_url).as_str(),
            format!("https://authorization.example/app/?theme=dark&iss=https%3A%2F%2F{DOMAIN}")
        );
        assert_eq!(authorization_server.minted_launches(), 0, "no launch");
        assert_eq!(presence.views().len(), 1, "its view is open");
        browser.close_top();
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_authorization_app_the_browser_can_t_open_leaves_no_view_open() {
        let authorization_server = test_authorization_server();
        let presence = OpenLaunchViews::default();

        let failed =
            open_launchable_authorization_app(&authorization_server, FailingBrowser, &presence)
                .await;

        assert_eq!(failed.map_err(|error| error.kind()), Err("openingBrowser"));
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_isn_t_launchable_opens_no_authorization_app() {
        let authorization_server = test_authorization_server();
        let (data_root, registry) = registry();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        let unreachable = running_with(&authorization_server, |detail| {
            detail.health = Some(ServerHealth::Unreachable {
                error: "the relay answered 502".to_owned(),
            });
        });

        let refused = open_authorization_app(
            registry,
            data_root.path(),
            &unreachable,
            DOMAIN.to_owned(),
            browser.clone(),
            presence.clone(),
        )
        .await;

        assert_eq!(refused.map_err(|error| error.kind()), Err("unreachable"));
        assert!(browser.opened().is_empty());
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
            let authorization_server = test_authorization_server();
            let (data_root, registry) = registry();
            let browser = PhoneBrowser::new(Phone::Ios);
            let presence = OpenLaunchViews::default();

            let refused = launch(
                registry,
                data_root.path(),
                &running_with(&authorization_server, change),
                DOMAIN.to_owned(),
                browser.clone(),
                presence.clone(),
            )
            .await;

            assert_eq!(refused.map_err(|error| error.kind()), Err(kind));
            assert!(browser.opened().is_empty(), "{kind}");
            assert!(presence.views().is_empty(), "{kind}");
            assert_eq!(authorization_server.minted_launches(), 0, "{kind}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_isn_t_launchable_opens_nothing() {
        let (data_root, registry) = registry();
        let browser = PhoneBrowser::new(Phone::Ios);
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
        let authorization_server = test_authorization_server();
        let (data_root, registry) = registry();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();

        let refused = launch(
            registry,
            data_root.path(),
            &launchable(&authorization_server),
            "lab.relay.example.com".to_owned(),
            browser.clone(),
            presence.clone(),
        )
        .await;

        assert_eq!(refused.map_err(|error| error.kind()), Err("notRegistered"));
        assert!(browser.opened().is_empty());
        assert!(presence.views().is_empty());
    }

    /// The servers' statuses with the server launchable over
    /// `authorization_server`, `newest` the newest consent waiting on it.
    fn launchable_waiting_on(
        authorization_server: &TestAuthorizationServer,
        newest: NewestPendingConsent,
    ) -> UnitStatuses<ServerDetail> {
        running_with(authorization_server, |detail| {
            detail.pending_consent = Some(newest);
        })
    }

    fn oauth_consent(id: &str) -> NewestPendingConsent {
        NewestPendingConsent::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
            requested_by_owner_browser: false,
        }
    }

    /// Open the consent waiting on the server [`DOMAIN`], whose statuses are
    /// `statuses`, in `browser`, with `presence` hearing its view, as the
    /// host opens a consent itself.
    async fn open_consent(
        statuses: &UnitStatuses<ServerDetail>,
        browser: impl LaunchBrowser,
        presence: &OpenLaunchViews,
    ) -> Result<(), LaunchError> {
        let (data_root, registry) = registry();
        open_pending_consent(
            registry,
            data_root.path(),
            statuses,
            DOMAIN.to_owned(),
            browser,
            presence.clone(),
            IfShowing::Skip,
        )
        .await
    }

    /// Wait, up to five seconds, for `browser` to show `views`, bottom first.
    async fn until_showing(browser: &PhoneBrowser, views: &[String]) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while browser.showing() != views {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("showing {:?}, not {views:?}", browser.showing()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_app_s_waiting_consent_opens_at_its_card_through_the_sign_in() {
        let authorization_server = test_authorization_server();
        authorization_server.park_consent("req-1");
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();

        open_consent(
            &launchable_waiting_on(&authorization_server, oauth_consent("req-1")),
            browser.clone(),
            &presence,
        )
        .await
        .unwrap();

        let opened = browser.opened();
        let [sign_in_url] = opened.as_slice() else {
            panic!("one consent opens: {opened:?}");
        };
        assert_eq!(
            next_of_sign_in(sign_in_url),
            "/oauth/authorize/req-1/consent?then=back"
        );
        assert_eq!(
            presence.views().len(),
            1,
            "its view counts as a launch view"
        );
        assert_eq!(authorization_server.minted_launches(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_s_waiting_consent_opens_at_the_device_page_with_its_code() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);

        open_consent(
            &launchable_waiting_on(
                &authorization_server,
                NewestPendingConsent::Device {
                    user_code: "ABCD-EFGH".to_owned(),
                    client_name: "Pebble".to_owned(),
                },
            ),
            browser.clone(),
            &OpenLaunchViews::default(),
        )
        .await
        .unwrap();

        let opened = browser.opened();
        let [sign_in_url] = opened.as_slice() else {
            panic!("one consent opens: {opened:?}");
        };
        assert_eq!(
            next_of_sign_in(sign_in_url),
            "/oauth/device?user_code=ABCD-EFGH&then=back"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_with_nothing_waiting_opens_nothing() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();

        let refused = open_consent(
            &launchable(&authorization_server),
            browser.clone(),
            &presence,
        )
        .await;

        assert!(
            matches!(&refused, Err(LaunchError::NothingPending { domain }) if domain == DOMAIN),
            "{refused:?}"
        );
        assert!(browser.opened().is_empty());
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_ios_a_consent_shows_over_a_launch_s_view_while_its_request_waits() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();
        authorization_server.park_consent("req-1");

        open_consent(
            &launchable_waiting_on(&authorization_server, oauth_consent("req-1")),
            browser.clone(),
            &presence,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(browser.opened().len(), 2);
        assert_eq!(
            browser.showing().into_iter().collect::<BTreeSet<_>>(),
            presence.views(),
            "the launch's view stays under the consent's"
        );
        assert_eq!(presence.views().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_ios_a_settled_consent_s_view_closes_and_reveals_the_view_under_it() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();
        let launch_view = browser.showing();

        // "req-1" isn't pending on the authorization server: decided, as far
        // as its watcher can tell.
        open_consent(
            &launchable_waiting_on(&authorization_server, oauth_consent("req-1")),
            browser.clone(),
            &presence,
        )
        .await
        .unwrap();

        until_showing(&browser, &launch_view).await;
        assert_eq!(browser.opened().len(), 2, "the consent opened first");
        assert_eq!(presence.views().len(), 1);
    }

    /// A consent's view opened over a launch's in `browser`, an iOS one, with
    /// `presence` hearing both, and the launch's view.
    async fn consent_over_a_launch(
        browser: &PhoneBrowser,
        presence: &OpenLaunchViews,
    ) -> (LaunchView, String) {
        let authorization_server = test_authorization_server();
        launch_launchable(&authorization_server, browser.clone(), presence)
            .await
            .unwrap();
        let [launch_view] = browser.showing().try_into().unwrap();
        let consent_view = open_launch_view(
            browser,
            presence.clone(),
            Url::parse(&format!("https://{DOMAIN}/oauth/sign-in")).unwrap(),
            OpenMode::Stack,
        )
        .await
        .unwrap();
        (consent_view, launch_view)
    }

    /// The claim of the consent `req-1` on the server [`DOMAIN`] in `views`.
    fn claim_in(views: &ConsentViews) -> ConsentViewClaim {
        views
            .claim(DOMAIN, &consent_key(), IfShowing::Skip)
            .unwrap()
    }

    fn consent_key() -> ConsentKey {
        ConsentKey::OAuth {
            id: "req-1".to_owned(),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_consent_s_view_closes_once_its_request_settles() {
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        let (consent_view, launch_view) = consent_over_a_launch(&browser, &presence).await;
        let (settle, settled) = tokio::sync::oneshot::channel::<()>();
        let views = ConsentViews::default();
        let closing = tokio::spawn(close_once_settled_view(
            browser.clone(),
            async move {
                settled.await.unwrap();
                Ok(())
            },
            consent_view,
            DOMAIN.to_owned(),
            claim_in(&views),
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            browser.showing().len(),
            2,
            "it stays while the request waits"
        );

        settle.send(()).unwrap();
        closing.await.unwrap();

        assert_eq!(browser.showing(), [launch_view]);
        assert_eq!(presence.views().len(), 1);
        assert!(!views.is_showing(DOMAIN, &consent_key()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_settled_consent_s_view_closes_once_a_transition_lets_it() {
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        let (consent_view, launch_view) = consent_over_a_launch(&browser, &presence).await;
        browser.views.lock().unwrap().refused_closes = 2;

        tokio::time::timeout(
            Duration::from_secs(5),
            close_once_settled_view(
                browser.clone(),
                async { Ok(()) },
                consent_view,
                DOMAIN.to_owned(),
                claim_in(&ConsentViews::default()),
            ),
        )
        .await
        .expect("it closes");

        assert_eq!(browser.showing(), [launch_view]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_consent_s_view_the_user_closes_first_stops_the_wait() {
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        let (consent_view, launch_view) = consent_over_a_launch(&browser, &presence).await;
        let views = ConsentViews::default();
        let closing = tokio::spawn(close_once_settled_view(
            browser.clone(),
            std::future::pending(),
            consent_view,
            DOMAIN.to_owned(),
            claim_in(&views),
        ));

        browser.close_top();

        tokio::time::timeout(Duration::from_secs(5), closing)
            .await
            .expect("the wait stops")
            .unwrap();
        assert_eq!(browser.showing(), [launch_view], "the launch's view stays");
        assert!(!views.is_showing(DOMAIN, &consent_key()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_watch_releases_the_consent_s_claim_and_leaves_its_view() {
        let browser = PhoneBrowser::new(Phone::Ios);
        let presence = OpenLaunchViews::default();
        let (consent_view, _launch_view) = consent_over_a_launch(&browser, &presence).await;
        let views = ConsentViews::default();

        // As when the run ends under the view.
        tokio::time::timeout(
            Duration::from_secs(5),
            close_once_settled_view(
                browser.clone(),
                async {
                    Err(AuthorizationServerError::infrastructure(
                        "watching a pending consent",
                        "the authorization server stopped",
                    ))
                },
                consent_view,
                DOMAIN.to_owned(),
                claim_in(&views),
            ),
        )
        .await
        .expect("it ends without waiting for the view to close");

        assert_eq!(browser.showing().len(), 2, "the view stays");
        assert!(!views.is_showing(DOMAIN, &consent_key()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_android_a_launch_while_a_consent_s_view_opens_opens_its_own() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Android);
        let presence = OpenLaunchViews::default();
        open_consent(
            &launchable_waiting_on(&authorization_server, oauth_consent("req-1")),
            browser.clone(),
            &presence,
        )
        .await
        .unwrap();

        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();

        assert_eq!(browser.opened().len(), 2, "the launch opened its own view");
        assert_eq!(browser.showing().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_android_a_consent_opens_a_view_of_its_own_over_a_launch_s() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Android);
        let presence = OpenLaunchViews::default();
        launch_launchable(&authorization_server, browser.clone(), &presence)
            .await
            .unwrap();

        open_consent(
            &launchable_waiting_on(&authorization_server, oauth_consent("req-1")),
            browser.clone(),
            &presence,
        )
        .await
        .unwrap();

        assert_eq!(browser.opened().len(), 2, "the consent opened its own view");
        assert_eq!(browser.showing().len(), 2);
        assert_eq!(presence.views().len(), 2);
        browser.close_top();
        browser.close_top();
        assert!(presence.views().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_consent_showing_opens_no_second_view_until_its_view_closes() {
        let authorization_server = test_authorization_server();
        authorization_server.park_consent("req-1");
        let statuses = launchable_waiting_on(&authorization_server, oauth_consent("req-1"));
        let browser = PhoneBrowser::new(Phone::Android);
        let presence = OpenLaunchViews::default();
        open_consent(&statuses, browser.clone(), &presence)
            .await
            .unwrap();

        // As a tap on its notification does after the return it brought.
        open_consent(&statuses, browser.clone(), &presence)
            .await
            .unwrap();
        assert_eq!(browser.opened().len(), 1, "it shows once");

        browser.close_top();
        let key = consent_key();
        tokio::time::timeout(Duration::from_secs(5), async {
            while presence.consent_views().is_showing(DOMAIN, &key) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("its close is heard");
        open_consent(&statuses, browser.clone(), &presence)
            .await
            .unwrap();
        assert_eq!(
            browser.opened().len(),
            2,
            "closed undecided, it opens again"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_owner_s_open_opens_a_consent_even_while_it_shows() {
        let authorization_server = test_authorization_server();
        authorization_server.park_consent("req-1");
        let statuses = launchable_waiting_on(&authorization_server, oauth_consent("req-1"));
        let browser = PhoneBrowser::new(Phone::Android);
        let presence = OpenLaunchViews::default();
        open_consent(&statuses, browser.clone(), &presence)
            .await
            .unwrap();

        let (data_root, registry) = registry();
        open_pending_consent(
            registry,
            data_root.path(),
            &statuses,
            DOMAIN.to_owned(),
            browser.clone(),
            presence.clone(),
            IfShowing::TakeOver,
        )
        .await
        .unwrap();

        assert_eq!(browser.opened().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_the_desktop_a_consent_shows_only_while_its_tab_opens() {
        let authorization_server = test_authorization_server();
        authorization_server.park_consent("req-1");
        let statuses = launchable_waiting_on(&authorization_server, oauth_consent("req-1"));
        let browser = DesktopBrowser::default();
        let presence = OpenLaunchViews::default();
        open_consent(&statuses, browser.clone(), &presence)
            .await
            .unwrap();

        assert!(
            !presence.consent_views().is_showing(DOMAIN, &consent_key()),
            "no close of its tab would ever release it"
        );
        open_consent(&statuses, browser.clone(), &presence)
            .await
            .unwrap();
        assert_eq!(browser.opened.lock().unwrap().len(), 2);
    }

    /// The servers' statuses with the server running over
    /// `authorization_server`, `newest` the newest consent waiting on it, but
    /// its health not probed yet, as at the app's start.
    fn not_yet_probed_waiting_on(
        authorization_server: &TestAuthorizationServer,
        newest: Option<NewestPendingConsent>,
    ) -> UnitStatuses<ServerDetail> {
        running_with(authorization_server, |detail| {
            detail.pending_consent = newest;
            detail.health = None;
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_notified_consent_opens_once_its_server_becomes_launchable() {
        let authorization_server = test_authorization_server();
        let (data_root, registry) = registry();
        let browser = PhoneBrowser::new(Phone::Ios);
        let (statuses_tx, statuses_rx) = watch::channel(not_yet_probed_waiting_on(
            &authorization_server,
            Some(oauth_consent("req-1")),
        ));
        let opening = {
            let browser = browser.clone();
            let data_root = data_root.path().to_owned();
            tokio::spawn(async move {
                open_consent_once_openable(
                    registry,
                    &data_root,
                    statuses_rx,
                    DOMAIN.to_owned(),
                    &ConsentKey::OAuth {
                        id: "req-1".to_owned(),
                    },
                    browser,
                    OpenLaunchViews::default(),
                )
                .await;
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(browser.opened().is_empty(), "not launchable yet");

        statuses_tx
            .send(launchable_waiting_on(
                &authorization_server,
                oauth_consent("req-1"),
            ))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), opening)
            .await
            .expect("it opens and stops")
            .unwrap();

        assert_eq!(browser.opened().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_notified_consent_decided_before_its_server_is_launchable_never_opens() {
        let authorization_server = test_authorization_server();
        let (data_root, registry) = registry();
        let browser = PhoneBrowser::new(Phone::Ios);
        let (statuses_tx, statuses_rx) = watch::channel(not_yet_probed_waiting_on(
            &authorization_server,
            Some(oauth_consent("req-1")),
        ));
        let opening = {
            let browser = browser.clone();
            let data_root = data_root.path().to_owned();
            tokio::spawn(async move {
                open_consent_once_openable(
                    registry,
                    &data_root,
                    statuses_rx,
                    DOMAIN.to_owned(),
                    &ConsentKey::OAuth {
                        id: "req-1".to_owned(),
                    },
                    browser,
                    OpenLaunchViews::default(),
                )
                .await;
            })
        };

        statuses_tx
            .send(not_yet_probed_waiting_on(
                &authorization_server,
                Some(oauth_consent("req-2")),
            ))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), opening)
            .await
            .expect("it stops")
            .unwrap();

        assert!(browser.opened().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_waiting_consent_on_a_server_that_isn_t_launchable_opens_nothing() {
        let authorization_server = test_authorization_server();
        let browser = PhoneBrowser::new(Phone::Ios);
        let statuses = running_with(&authorization_server, |detail| {
            detail.pending_consent = Some(oauth_consent("req-1"));
            detail.health = None;
        });

        let refused = open_consent(&statuses, browser.clone(), &OpenLaunchViews::default()).await;

        assert!(
            matches!(&refused, Err(LaunchError::NotYetProbed { domain }) if domain == DOMAIN),
            "{refused:?}"
        );
        assert!(browser.opened().is_empty());
    }
}
