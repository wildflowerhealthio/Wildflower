//! Tauri glue for the background server service: the plugin's
//! [`BackgroundService`] that runs the Wildflower server, starting and
//! restarting it, the status snapshot on the bridge, and the notifications and
//! error dialog. See the [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! Every decision lives in [`background_server_service_rust`], which needs no
//! webview to be tested; this module only wires those decisions to the plugins'
//! events and calls.

use std::time::Instant;

use background_server_service_rust::{
    failure_notification, stop_notification, BackgroundServerServiceHostToWeb,
    BackgroundServerServiceWebToHost, BackgroundServiceEvent, LocalNotification,
    NotificationPermission, ReachDropDetector, RequestNotificationCoalescer, ServerHostContext,
    ServerRunState, ServerServiceReceivers, ServerServiceStatus, ServiceStopReason,
    BACKGROUND_SERVICE_EVENT, RESTART_SERVER, RESTART_STOP_REASON, TAGS,
};
use shared_structures_rust::bridge::{BridgeEnvelope, BRIDGE_EVENT, READY_TAG};
use shared_structures_rust::request_caller::ForwardedRequest;
use std::sync::{Arc, OnceLock};
use tauri::plugin::PermissionState;
use tauri::{AppHandle, Emitter, EventId, Listener, Manager, Runtime};
use tauri_plugin_background_service::{
    BackgroundService, ServiceContext, ServiceError, ServiceManagerHandle, StartConfig,
};
use tauri_plugin_dialog::{Dialog, MessageDialogKind};
use tauri_plugin_log::log;
use tauri_plugin_notification::Notification;
use tokio::sync::{mpsc, watch, Notify};
use wildflower_server_rust::ServerHealth;

mod stop_reason;

/// Tauri window label of the main webview, whose suspend and resume restart
/// the server on a phone.
#[cfg(any(target_os = "ios", target_os = "android"))]
const MAIN_WINDOW_LABEL: &str = "main";

/// The plugin's service: each run runs the Wildflower server through the
/// host's [`ServerHostContext`].
///
/// The plugin builds a fresh instance for every start, from a factory the host
/// registers before its `setup()` has built the context (the context needs the
/// `AppHandle`). So the instance holds a receiver the host publishes the
/// context on, and a run waits for it — which also covers a start the plugin
/// makes on its own before `setup()` finishes.
pub struct WildflowerServerService {
    host_context: watch::Receiver<Option<ServerHostContext>>,
}

impl WildflowerServerService {
    /// A service whose runs use the context published on `host_context`.
    #[must_use]
    pub fn new(host_context: watch::Receiver<Option<ServerHostContext>>) -> Self {
        Self { host_context }
    }

    async fn published_host_context(&mut self) -> Result<ServerHostContext, ServiceError> {
        let published = self
            .host_context
            .wait_for(Option::is_some)
            .await
            .map_err(|_| {
                ServiceError::Runtime(
                    "the host dropped the server context without publishing it".to_owned(),
                )
            })?;
        published
            .clone()
            .ok_or_else(|| ServiceError::Runtime("the host published no server context".to_owned()))
    }
}

#[async_trait::async_trait]
impl<R: Runtime> BackgroundService<R> for WildflowerServerService {
    async fn init(&mut self, _ctx: &ServiceContext<R>) -> Result<(), ServiceError> {
        Ok(())
    }

    /// Run the server until the plugin stops the service or the server fails.
    /// A failure is the server's `{:#}` chain, which the plugin reports as an
    /// `Error` event.
    async fn run(&mut self, ctx: &ServiceContext<R>) -> Result<(), ServiceError> {
        let host_context = tokio::select! {
            () = ctx.shutdown.cancelled() => return Ok(()),
            published = self.published_host_context() => published?,
        };
        host_context
            .run_server(&ctx.shutdown)
            .await
            .map_err(|error| ServiceError::Runtime(format!("{error:#}")))
    }
}

/// Start the background service as `start_config` says. A service that is
/// already running counts as started. A failure to start is reported like a
/// server failure: logged, a notification, and the native error dialog. No
/// run begins, so no plugin event follows: the stop reason becomes
/// [`ServiceStopReason::Error`] here, which also replaces a restart's own
/// `AppStop` so the page doesn't wait on a restart that isn't coming.
async fn start_server_service<R: Runtime>(
    app: &AppHandle<R>,
    start_config: &StartConfig,
    last_stop_reason: &watch::Sender<Option<ServiceStopReason>>,
) {
    let Some(service_manager) = app.try_state::<ServiceManagerHandle<R>>() else {
        last_stop_reason.send_replace(Some(ServiceStopReason::Error));
        report_server_failure(app, "the background-service plugin is not registered");
        return;
    };
    match service_manager
        .start(app.clone(), start_config.clone())
        .await
    {
        Ok(()) | Err(ServiceError::AlreadyRunning) => {}
        Err(error) => {
            last_stop_reason.send_replace(Some(ServiceStopReason::Error));
            report_server_failure(app, &format!("failed to start: {error}"));
        }
    }
}

/// Stop the service if it is running, then start it as `start_config` says. The
/// stop uses [`RESTART_STOP_REASON`], so it posts no stop notification; the new
/// run waits for the old one at the run gate.
///
/// The stop reason is recorded here, once the stop is accepted, rather than
/// from the plugin's `Stopped` event: that event comes from the old run's task
/// whenever it ends, which may be after a rejected start has recorded `Error`.
async fn restart_server_service<R: Runtime>(
    app: &AppHandle<R>,
    start_config: &StartConfig,
    last_stop_reason: &watch::Sender<Option<ServiceStopReason>>,
) {
    let Some(service_manager) = app.try_state::<ServiceManagerHandle<R>>() else {
        report_server_failure(app, "the background-service plugin is not registered");
        return;
    };
    match service_manager
        .stop_with_reason(stop_reason::to_plugin(RESTART_STOP_REASON))
        .await
    {
        Ok(()) => {
            last_stop_reason.send_replace(Some(RESTART_STOP_REASON));
            start_server_service(app, start_config, last_stop_reason).await;
        }
        Err(ServiceError::NotRunning) => {
            start_server_service(app, start_config, last_stop_reason).await;
        }
        Err(error) => report_server_failure(app, &format!("failed to stop for a restart: {error}")),
    }
}

/// Wire the service's status, its restart request, and its notifications, then
/// start it. Every start, restarts included, uses `start_config`: the text of
/// Android's persistent foreground-service notification, which the plugin can't
/// change once the service has started, and the Android foreground-service type,
/// which the plugin config's `androidForegroundServiceTypes` must allow (the
/// plugin checks it on every platform).
///
/// - Emits a [`ServerServiceStatus`] on [`BRIDGE_EVENT`] whenever the run state
///   or the last stop reason changes, in reply to every `__Ready`, and once the
///   notification permission is answered.
/// - Restarts the service on a `RestartServer` from the page.
/// - Listens on the plugin's [`BACKGROUND_SERVICE_EVENT`] for stop reasons,
///   posting the stop notification, and for errors, which also raise the native
///   error dialog.
/// - Posts the per-caller request notifications and the notifications for the
///   server becoming unreachable through its public origin and reachable again.
/// - On a phone, starts the server when the app comes back to the foreground
///   with it stopped, and on iOS restarts a running one.
/// - Asks for permission to post notifications if the OS has never asked
///   (see [`ask_for_notification_permission`]), then starts the service. The
///   start comes from here rather than the page, so the server runs whether or
///   not the webview loads.
///
/// Registers its listeners synchronously, so call it from `setup()` before the
/// page can send `__Ready`. Call once per app lifecycle.
pub fn start_background_server_service<R: Runtime>(
    app: &AppHandle<R>,
    receivers: ServerServiceReceivers,
    start_config: StartConfig,
) {
    // The shared bridge channel has no automated cross-process tag guard, so
    // the boot log records who dispatches what.
    log::info!(
        "[background-server-service] listening on '{BRIDGE_EVENT}' for tags: {TAGS:?}, \
         and on '{BACKGROUND_SERVICE_EVENT}'"
    );
    let ServerServiceReceivers {
        run_state,
        server_health,
        forwarded_requests,
    } = receivers;
    let status_wanted = Arc::new(Notify::new());
    let (last_stop_reason_sender, last_stop_reason) = watch::channel(None);

    listen_for_bridge_messages(
        app,
        Arc::clone(&status_wanted),
        start_config.clone(),
        last_stop_reason_sender.clone(),
    );
    listen_for_plugin_events(app, last_stop_reason_sender.clone(), run_state.clone());
    #[cfg(any(target_os = "ios", target_os = "android"))]
    start_or_restart_on_foreground_resume(
        app,
        run_state.clone(),
        start_config.clone(),
        last_stop_reason_sender.clone(),
    );
    tauri::async_runtime::spawn(emit_status_changes(
        app.clone(),
        Arc::clone(&status_wanted),
        run_state,
        last_stop_reason,
    ));
    tauri::async_runtime::spawn(post_request_notifications(app.clone(), forwarded_requests));
    tauri::async_runtime::spawn(post_reach_notifications(app.clone(), server_health));

    let launch_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Asked before the first start: the plugin's own start asks too, and on
        // Android a second ask while the first is on screen is cancelled, which
        // the notification plugin reports as a refusal. A grant answered here
        // leaves the plugin nothing to ask.
        ask_for_notification_permission(&launch_handle).await;
        status_wanted.notify_one();
        start_server_service(&launch_handle, &start_config, &last_stop_reason_sender).await;
    });
}

/// Report that there is no server to run, instead of
/// [`start_background_server_service`]: nothing starts, and every `__Ready`
/// from the page is answered with a [`ServerServiceStatus`] that is stopped with
/// no error, so the page shows a stopped server rather than waiting on one.
/// No run means no failure: there's no notification or error dialog.
///
/// A `RestartServer` from the page calls `start_server_to_run`, which starts
/// the server set running since (through [`start_background_server_service`])
/// and returns `true`, or returns `false` when there is still none. Once it
/// has started one, this stops answering the page, and the started service's
/// own listeners take over; until then each restart is answered with the
/// stopped status again.
///
/// Registers its listener synchronously, so call it from `setup()` before the
/// page can send `__Ready`. Call once per app lifecycle, and never alongside
/// [`start_background_server_service`].
pub fn report_no_server<R: Runtime>(
    app: &AppHandle<R>,
    start_server_to_run: impl Fn(&AppHandle<R>) -> bool + Send + Sync + 'static,
) {
    log::info!("[background-server-service] no server is set to run; none started");
    let handle = app.clone();
    let listener: Arc<OnceLock<EventId>> = Arc::new(OnceLock::new());
    let listener_in_handler = Arc::clone(&listener);
    let id = app.listen(BRIDGE_EVENT, move |event| {
        let Ok(envelope) = serde_json::from_str::<BridgeEnvelope>(event.payload()) else {
            return;
        };
        if envelope.tag == RESTART_SERVER && start_server_to_run(&handle) {
            if let Some(&id) = listener_in_handler.get() {
                handle.unlisten(id);
            }
        } else if envelope.tag == READY_TAG || envelope.tag == RESTART_SERVER {
            emit_status(&handle, &ServerRunState::Stopped { error: None }, None);
        }
    });
    let _ = listener.set(id);
}

/// Route the page's `__Ready` (a status snapshot is wanted) and `RestartServer`
/// (a restart as `start_config` says). Sibling slices' tags and this slice's
/// own `ServerServiceStatus` echo are dropped.
fn listen_for_bridge_messages<R: Runtime>(
    app: &AppHandle<R>,
    status_wanted: Arc<Notify>,
    start_config: StartConfig,
    last_stop_reason_sender: watch::Sender<Option<ServiceStopReason>>,
) {
    let handle = app.clone();
    app.listen(BRIDGE_EVENT, move |event| {
        let payload = event.payload();
        let tag = match serde_json::from_str::<BridgeEnvelope>(payload) {
            Ok(envelope) => envelope.tag,
            Err(error) => {
                log::warn!(
                    "[background-server-service] undecodable bridge payload dropped: {error}"
                );
                return;
            }
        };
        if tag == READY_TAG {
            status_wanted.notify_one();
        } else if tag == RESTART_SERVER {
            match serde_json::from_str::<BackgroundServerServiceWebToHost>(payload) {
                Ok(BackgroundServerServiceWebToHost::RestartServer) => {
                    let handle = handle.clone();
                    let start_config = start_config.clone();
                    let last_stop_reason_sender = last_stop_reason_sender.clone();
                    tauri::async_runtime::spawn(async move {
                        restart_server_service(&handle, &start_config, &last_stop_reason_sender)
                            .await;
                    });
                }
                Err(error) => log::warn!(
                    "[background-server-service] undecodable {RESTART_SERVER} payload: {error}"
                ),
            }
        }
    });
}

/// Turn the plugin's lifecycle events into the last stop reason, the stop
/// notification, and — for an error — the failure report.
fn listen_for_plugin_events<R: Runtime>(
    app: &AppHandle<R>,
    last_stop_reason_sender: watch::Sender<Option<ServiceStopReason>>,
    run_state: watch::Receiver<ServerRunState>,
) {
    let handle = app.clone();
    app.listen(BACKGROUND_SERVICE_EVENT, move |event| {
        match serde_json::from_str::<BackgroundServiceEvent>(event.payload()) {
            Ok(BackgroundServiceEvent::Started) => {
                log::debug!("[background-server-service] service started");
            }
            Ok(BackgroundServiceEvent::Stopped { reason }) => {
                log::info!("[background-server-service] service stopped: {reason:?}");
                // A restart records its own stop reason (see
                // `restart_server_service`).
                if reason != RESTART_STOP_REASON {
                    last_stop_reason_sender.send_replace(Some(reason));
                }
                if let Some(notification) = stop_notification(reason) {
                    show_notification(&handle, &notification);
                }
            }
            Ok(BackgroundServiceEvent::Error { message }) => {
                last_stop_reason_sender.send_replace(Some(ServiceStopReason::Error));
                // The run publishes its own error before the plugin reports
                // it, so the dialog shows the same text as the page.
                let error = match &*run_state.borrow() {
                    ServerRunState::Stopped { error: Some(error) } => error.clone(),
                    ServerRunState::Starting
                    | ServerRunState::Running
                    | ServerRunState::Stopped { error: None } => message,
                };
                report_server_failure(&handle, &error);
            }
            Err(error) => log::warn!(
                "[background-server-service] undecodable {BACKGROUND_SERVICE_EVENT} payload: {error}"
            ),
        }
    });
}

/// Emit the current [`ServerServiceStatus`] on every run-state or stop-reason
/// change and whenever `status_wanted` is notified. One task emits every
/// snapshot, so the last one the page receives is always the current one.
async fn emit_status_changes<R: Runtime>(
    app: AppHandle<R>,
    status_wanted: Arc<Notify>,
    mut run_state: watch::Receiver<ServerRunState>,
    mut last_stop_reason: watch::Receiver<Option<ServiceStopReason>>,
) {
    loop {
        tokio::select! {
            () = status_wanted.notified() => {}
            changed = run_state.changed() => if changed.is_err() {
                log::error!("[background-server-service] run-state channel closed; status delivery stopped");
                return;
            },
            changed = last_stop_reason.changed() => if changed.is_err() {
                log::error!("[background-server-service] stop-reason channel closed; status delivery stopped");
                return;
            },
        }
        let current_run_state = run_state.borrow_and_update().clone();
        let current_stop_reason = *last_stop_reason.borrow_and_update();
        emit_status(&app, &current_run_state, current_stop_reason);
    }
}

/// Emit a [`ServerServiceStatus`] for `run_state` and `stop_reason` on
/// [`BRIDGE_EVENT`], with the current notification permission.
fn emit_status<R: Runtime>(
    app: &AppHandle<R>,
    run_state: &ServerRunState,
    stop_reason: Option<ServiceStopReason>,
) {
    let status = ServerServiceStatus::new(run_state, stop_reason, notification_permission(app));
    let message = BackgroundServerServiceHostToWeb::ServerServiceStatus(status);
    if let Err(error) = app.emit(BRIDGE_EVENT, &message) {
        log::error!("[background-server-service] failed to emit {message:?}: {error}");
    }
}

/// Post the per-caller request notifications the coalescer decides on, waking
/// for each owed update when it comes due.
async fn post_request_notifications<R: Runtime>(
    app: AppHandle<R>,
    mut forwarded_requests: mpsc::Receiver<ForwardedRequest>,
) {
    let mut coalescer = RequestNotificationCoalescer::new();
    loop {
        let next_update_due_at = coalescer.next_update_due_at();
        tokio::select! {
            forwarded_request = forwarded_requests.recv() => {
                let Some(forwarded_request) = forwarded_request else {
                    log::error!("[background-server-service] forwarded-request channel closed; request notifications stopped");
                    return;
                };
                if let Some(activity) = coalescer.record(forwarded_request, Instant::now()) {
                    show_notification(&app, &activity.notification());
                }
            }
            () = sleep_until_due(next_update_due_at) => {
                for activity in coalescer.take_due_updates(Instant::now()) {
                    show_notification(&app, &activity.notification());
                }
            }
        }
    }
}

/// Sleep until `due_at`, or forever when nothing is due.
async fn sleep_until_due(due_at: Option<Instant>) {
    match due_at {
        Some(due_at) => tokio::time::sleep_until(due_at.into()).await,
        None => std::future::pending().await,
    }
}

/// Post the unreachable and reachable-again notifications as the running
/// server's health through its public origin changes.
async fn post_reach_notifications<R: Runtime>(
    app: AppHandle<R>,
    mut server_health: watch::Receiver<Option<ServerHealth>>,
) {
    let mut reach_drops = ReachDropDetector::new();
    while server_health.changed().await.is_ok() {
        let notification = reach_drops.notification_for(server_health.borrow_and_update().as_ref());
        if let Some(notification) = notification {
            show_notification(&app, &notification);
        }
    }
    log::error!(
        "[background-server-service] server-health channel closed; reach notifications stopped"
    );
}

/// Follow the main window's suspend and resume, and start or restart the
/// server on a resume that follows a suspend (see
/// [`background_server_service_rust::ForegroundResume`]).
///
/// The window events, not `RunEvent::Resumed`: tauri-runtime-wry raises that
/// one on an event-loop poll, not when the app comes back.
#[cfg(any(target_os = "ios", target_os = "android"))]
fn start_or_restart_on_foreground_resume<R: Runtime>(
    app: &AppHandle<R>,
    run_state: watch::Receiver<ServerRunState>,
    start_config: StartConfig,
    last_stop_reason_sender: watch::Sender<Option<ServiceStopReason>>,
) {
    use background_server_service_rust::{ForegroundResume, ResumeAction};

    let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!(
            "[background-server-service] window '{MAIN_WINDOW_LABEL}' missing; the server won't restart on resume"
        );
        return;
    };
    let foreground = std::sync::Mutex::new(ForegroundResume::new());
    let handle = app.clone();
    main_window.on_window_event(move |event| {
        // The guarded value is one flag that no panic can leave half-written,
        // so a poisoned lock's value is still the right one.
        let mut foreground = foreground
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let action = match event {
            tauri::WindowEvent::Suspended => {
                foreground.suspended();
                None
            }
            tauri::WindowEvent::Resumed => {
                foreground.resumed(&run_state.borrow(), cfg!(target_os = "ios"))
            }
            _ => None,
        };
        let handle = handle.clone();
        let start_config = start_config.clone();
        let last_stop_reason_sender = last_stop_reason_sender.clone();
        match action {
            Some(ResumeAction::Start) => {
                tauri::async_runtime::spawn(async move {
                    start_server_service(&handle, &start_config, &last_stop_reason_sender).await;
                });
            }
            Some(ResumeAction::Restart) => {
                tauri::async_runtime::spawn(async move {
                    restart_server_service(&handle, &start_config, &last_stop_reason_sender).await;
                });
            }
            None => {}
        }
    });
}

/// Whether the host may post notifications, as the notification plugin reports
/// it; [`NotificationPermission::Unknown`] when the OS hasn't asked yet or the
/// plugin can't say.
fn notification_permission<R: Runtime>(app: &AppHandle<R>) -> NotificationPermission {
    let Some(notification) = app.try_state::<Notification<R>>() else {
        log::warn!("[background-server-service] the notification plugin is not registered");
        return NotificationPermission::Unknown;
    };
    match notification.permission_state() {
        Ok(PermissionState::Granted) => NotificationPermission::Granted,
        Ok(PermissionState::Denied) => NotificationPermission::Denied,
        Ok(PermissionState::Prompt | PermissionState::PromptWithRationale) => {
            NotificationPermission::Unknown
        }
        Err(error) => {
            log::warn!("[background-server-service] notification permission unreadable: {error}");
            NotificationPermission::Unknown
        }
    }
}

/// Ask the OS for permission to post notifications when it has never asked
/// (iOS, and Android 13 and later), and log the answer when it isn't a grant.
/// The server never depends on the answer; the snapshot reports it.
///
/// Only a `Prompt` state is asked about. An unreadable state isn't: on Android
/// the notification plugin never answers a request for a permission already
/// granted, and the service's start waits on this. Desktop always reads as
/// granted. The plugin's mobile calls block until the native side answers, and
/// the request until the person does, so both run on a blocking thread.
async fn ask_for_notification_permission<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let asked = tauri::async_runtime::spawn_blocking(move || {
        let Some(notifications) = handle.try_state::<Notification<R>>() else {
            return Err("the notification plugin is not registered".to_owned());
        };
        let permission_before_asking = notifications
            .permission_state()
            .map_err(|error| format!("the permission is unreadable: {error}"))?;
        match permission_before_asking {
            PermissionState::Prompt | PermissionState::PromptWithRationale => notifications
                .request_permission()
                .map(Some)
                .map_err(|error| format!("the request failed: {error}")),
            PermissionState::Granted | PermissionState::Denied => Ok(None),
        }
    })
    .await;
    match asked {
        Ok(Ok(Some(PermissionState::Granted))) => {
            log::info!("[background-server-service] notifications allowed");
        }
        Ok(Ok(Some(
            answer @ (PermissionState::Denied
            | PermissionState::Prompt
            | PermissionState::PromptWithRationale),
        ))) => log::warn!(
            "[background-server-service] notifications not allowed ({answer}); the server runs, but its notifications won't show"
        ),
        // Already answered, on an earlier launch or in the OS settings.
        Ok(Ok(None)) => {}
        Ok(Err(error)) => log::warn!(
            "[background-server-service] notification permission not asked for: {error}"
        ),
        Err(error) => log::error!(
            "[background-server-service] the notification permission task failed: {error}"
        ),
    }
}

/// Post `notification`. A failure is logged: the notification is the end of
/// the line, with nothing further to report it to.
fn show_notification<R: Runtime>(app: &AppHandle<R>, notification: &LocalNotification) {
    let Some(notifications) = app.try_state::<Notification<R>>() else {
        log::warn!(
            "[background-server-service] the notification plugin is not registered; {} not posted",
            notification.id
        );
        return;
    };
    if let Err(error) = notifications
        .builder()
        .id(notification.numeric_id())
        .title(&notification.title)
        .body(&notification.body)
        .show()
    {
        log::warn!(
            "[background-server-service] notification {} failed: {error}",
            notification.id
        );
    }
}

/// Report that the server failed or couldn't be started: the log, the stop
/// notification, and the native error dialog. The dialog shows even when the
/// webview itself can't load, and doesn't block: the service task must not.
pub fn report_server_failure<R: Runtime>(app: &AppHandle<R>, error: &str) {
    log::error!("[background-server-service] Wildflower server stopped: {error}");
    show_notification(app, &failure_notification(error));
    match app.try_state::<Dialog<R>>() {
        Some(dialog) => dialog
            .message(format!("Wildflower server stopped: {error}"))
            .kind(MessageDialogKind::Error)
            .title("Wildflower")
            .show(|_| {}),
        None => log::warn!("[background-server-service] the dialog plugin is not registered"),
    }
}
