# Tauri Unit Runner — Design Explanation

How `tauri-unit-runner-rust` binds `unit-runner-rust` to a Tauri app: the background
session as `tauri-plugin-background-service`'s one service, and whether the app
is present from its window events.

The units, run policies, statuses, starting and stopping runs per policy, runs,
restarts and the session ledger are `unit-runner-rust`'s, and so are the words used
here. Its [Design Explanation](../../unit-runner-rust/docs/Design%20Explanation.md)
covers them. This crate re-exports every public type of `unit-runner-rust`, so the
app needs only `tauri-unit-runner-rust`, while its domain crates depend on
`unit-runner-rust` alone.

## The contract

```rust
impl<D: Clone + Send + Sync + 'static> TauriUnitRunner<D> {
    pub fn new(
        start_config: BackgroundServiceStartConfig,
        background_session_length: BackgroundSessionLength,
    ) -> Self;
    pub fn background_service_plugin<R: Runtime>(&self) -> TauriPlugin<R, PluginConfig>;
    pub fn lifecycle_plugin<R: Runtime>(&self) -> TauriPlugin<R>;

    pub fn set_unit<U: Unit<Detail = D>>(
        &self,
        unit_id: UnitId,
        policy: RunPolicy,
        factory: impl Fn() -> anyhow::Result<U> + Send + Sync + 'static,
    );
    pub fn set_unit_policy(&self, unit_id: &UnitId, policy: RunPolicy);
    pub async fn remove_unit(&self, unit_id: &UnitId);
    pub fn statuses(&self) -> UnitStatuses<D>;
    pub fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>>;
    pub fn browser_view_opened(&self, view: &str);
    pub fn browser_view_closed(&self, view: &str);
}
```

`TauriUnitRunner` is a `UnitRunner` on Tauri's async runtime and the system
wall clock, with the Tauri side's own state. Its unit calls are `UnitRunner`'s.
The app passes the background session length its plugin config allows:
`GracePeriod` when the Android service is a `shortService`, `AsLongAsNeeded`
otherwise.

The app builds `TauriUnitRunner` before the Tauri builder and registers its two
plugins: `background_service_plugin()` (the background session) and
`lifecycle_plugin()` (whether the app is present, its returns to the
foreground, and starting and
ending the background session), next to `tauri-plugin-notification`. The plugin
takes its service factory before the app's `setup()`, which is why
`TauriUnitRunner` is built before the Tauri builder and passed to it.

## Present

The lifecycle plugin tells `UnitRunner` whether the app is present:

- **Desktop.** It counts the app's windows as they are created and destroyed.
  The app is present while any window is open, minimized included.
- **Phone.** It follows the windows' `Suspended` and `Resumed` events: the app
  moving to the background and returning to the foreground. The app is present
  while it is in the foreground. `RunEvent::Resumed` isn't used, as
  tauri-runtime-wry raises it on an event-loop poll, not when the app comes
  back.
- **Android, in an in-app browser view.** A Custom Tab is an activity of its
  own over the app's, so opening one pauses the app and its window reports
  `Suspended`, though the user is still in the app. Switching to another app
  from the view and back returns to the view, so the app's window doesn't
  resume until the view is gone. The app reports each view it opens and closes
  (`browser_view_opened`, `browser_view_closed`, one id per open), and while
  any is open the app stays present. A Custom Tab runs in its browser's
  process, though, so Android treats the app under it as in the background
  and cuts its network a few seconds in, unless the browser keeps the app
  alive by binding a service of the app's. So from the open, before the view
  pauses the app, the app is present in the background
  (`Presence::PresentInBackground`), and the background session starts while
  the app is still in front, as Android requires of a `shortService`. When
  the browser binds, the app reports it (`browser_view_kept_alive`), and once
  every open view is kept alive the app is plainly present and the session is
  no longer needed. A browser that never binds leaves the session running,
  until Android times it out after 3 minutes. On iOS an
  `SFSafariViewController` is presented in the app's window, which stays in
  the foreground, and on a desktop the view is a default-browser tab, which
  never reports its close; neither keeps a view.
- **iOS, back in the foreground.** On iOS, moving to the background can break
  the app's sockets (`PlatformKind::backgrounding_breaks_sockets`): a suspended
  app's connections may be dead while its runs still report `Running`. So a
  return to the foreground that follows a move to the background restarts
  every running unit (`StoppedForRestart`). The resume a window reports as it
  first appears doesn't count.

Tauri raises no system resume on a desktop, so after a laptop sleeps
`UnitRunner`'s wall-clock ticker catches what ran out. A phone app's return to
the foreground is the window's `Resumed`, which also makes the app present.

## The background session: the plugin's one service

`TauriUnitRunner` registers exactly one `BackgroundService` for the whole app,
however many units there are. While that service runs, it is the background
session: its `run()` tells `UnitRunner` the session started, and waits until the
plugin shuts it down. Units don't run inside the service's task.

- **Starting and ending it.** `UnitRunner`'s `BackgroundSessionPlatform` port is
  the plugin's `ServiceManagerHandle`. A start resolves once the plugin has
  spawned the service's task, and a stop once it has cancelled the task's
  shutdown token; the task itself reports the session's start and end. A start
  of a service already running, and a stop of one already stopped, count as
  done. When no unit should run, `TauriUnitRunner` stops the service with
  `AppStop`, a stop reason that the plugin never uses itself, so that end is
  never mistaken for the platform's.
- **From `RunEvent::Ready`.** The lifecycle plugin hands `UnitRunner` the plugin
  as its background session platform once the app's event loop is ready, which
  follows the app's `setup()`. So a session the platform started at launch is
  judged once the app has set its units.
- **Starts the platform makes.** The plugin or the OS may start the service
  itself: an iOS background task, or the plugin's recovery. That run just tells
  `UnitRunner` a session started.
- **Why it ended.** The service's task sees only its shutdown token. The plugin
  names the reason in its `background-service://event` once the task has
  returned, so the task waits up to `SESSION_END_REASON_WAIT` (1 s) for
  that event before it reports the end. A reason that doesn't come in time, or
  that `TauriUnitRunner` doesn't know, is `PlatformStopReason::Unknown`.
- **Notification permission.** Before its first start, `TauriUnitRunner` asks
  for notification permission if the OS has never asked. The plugin's own start
  asks too, and on Android a second ask while the first is on screen reads as a
  refusal.
- **Android.** The plugin's persistent foreground-service notification, with the
  start config's label, covers every unit. With a `shortService` and
  `GracePeriod`, the session starts as the app moves to the background
  (`Suspended`) and ends as no longer needed when the grace period does,
  before Android's 3-minute limit.

## What the app does

Besides what `unit-runner-rust` asks of every app, it configures the plugin: the
start config, `plugins.background-service` in `tauri.conf.json`, the Android
manifest and the iOS background modes.

## Deliberately not here

- The plugin's desktop OS-service (daemon) mode.
