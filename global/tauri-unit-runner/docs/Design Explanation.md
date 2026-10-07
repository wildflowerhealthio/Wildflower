# Tauri Unit Runner — Design Explanation

How `tauri-unit-runner` binds `unit-runner` to a Tauri app: the keep-alive as
`tauri-plugin-background-service`'s one service, and whether the app is open
from its window events.

The units, run policies, statuses, the reconcile, runs, restarts and the
keep-alive ledger are `unit-runner`'s, and so are the words used here. Its
[Design Explanation](../../unit-runner/docs/Design%20Explanation.md) covers
them. This crate re-exports every public type of `unit-runner`, so the app
needs only `tauri-unit-runner`, while its domain crates depend on `unit-runner`
alone.

## The contract

```rust
impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    pub fn new(start_config: BackgroundServiceStartConfig) -> Self;
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
}
```

`UnitRunner` is a `UnitRunnerCore` on Tauri's async runtime and the system
wall clock, with the Tauri side's own state. Its unit calls are the core's.

The app builds the runner before the Tauri builder and registers its two
plugins: `background_service_plugin()` (the keep-alive) and
`lifecycle_plugin()` (whether the app is open, its resumes, and starting and
stopping the keep-alive), next to `tauri-plugin-notification`. The plugin
takes its service factory before the app's `setup()`, which is why the runner
is built before the Tauri builder and passed to it.

## Open

The lifecycle plugin tells the core whether the app is open:

- **Desktop.** It counts the app's windows as they are created and destroyed.
  The app is open while any window is, minimized included.
- **Phone.** It follows the windows' `Suspended` and `Resumed` events. The app
  is open while it is in the foreground. `RunEvent::Resumed` isn't used, as
  tauri-runtime-wry raises it on an event-loop poll, not when the app comes
  back.
- **iOS resume.** On iOS, a resume that follows a suspend restarts every
  running unit (`StoppedForRestart`): a suspended app's connections may be
  dead while its runs still report `Running`. The resume a window reports as it
  first appears doesn't count.

Tauri raises no system resume on a desktop, so after a laptop sleeps the core's
wall-clock reconcile catches what ran out. A phone's app resume is the window's
`Resumed`, which also opens the app.

## The keep-alive: the plugin's one service

The runner registers exactly one `BackgroundService` for the whole app, however
many units there are. That service's task is the keep-alive: its `run()` tells
the core it started, and waits until the plugin shuts it down. Units don't run
inside that task.

- **Starting and stopping it.** The core's `KeepAlivePlatform` port is the
  plugin's `ServiceManagerHandle`. A start of a service already running, and a
  stop of one already stopped, count as done. The runner's own stops carry
  `AppStop`, a stop reason that the plugin never uses itself, so they are never
  mistaken for platform stops.
- **From `RunEvent::Ready`.** The lifecycle plugin hands the core the plugin
  as its keep-alive platform once the app's event loop is ready, which follows
  the app's `setup()`. So a keep-alive the platform started at launch is judged
  once the app has set its units.
- **Starts the platform makes.** The plugin or the OS may start the service
  itself: an iOS background task, or the plugin's recovery. That run just tells
  the core the keep-alive started.
- **Why it ended.** The service's task sees only its shutdown token. The plugin
  names the reason in its `background-service://event` once the task has
  returned, so the task waits up to `KEEP_ALIVE_END_REASON_WAIT` (1 s) for
  that event before it reports the end. A reason that doesn't come in time, or
  that the runner doesn't know, is `PlatformStopReason::Unknown`.
- **Notification permission.** Before its first start, the runner asks for
  notification permission if the OS has never asked. The plugin's own start
  asks too, and on Android a second ask while the first is on screen reads as
  a refusal.
- **Android.** The plugin's persistent foreground-service notification, with the
  start config's label, covers every unit.

## What the app does

Besides what `unit-runner` asks of every app, it configures the plugin: the
start config, `plugins.background-service` in `tauri.conf.json`, the Android
manifest and the iOS background modes.

## Deliberately not here

- The plugin's desktop OS-service (daemon) mode.
