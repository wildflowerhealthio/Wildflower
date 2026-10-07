# Tauri Unit Runner — Design Explanation

What the runner is for, the words it uses, and how it starts, watches, restarts
and ends a unit's runs.

## What it is

`tauri-unit-runner` runs a Tauri app's long-lived background work. Each piece
of work is a **unit**: something that runs until it is asked to stop, or fails.
The app tells the runner which units exist and when each should run. The runner
then:

- starts and stops units to match their run policies
- restarts units that fail
- keeps the app alive in the background while any unit runs
- reports each unit's status

The runner knows nothing about what a unit does. A unit that serves HTTP through
a tunnel with its own TLS is as opaque to it as one that syncs a folder.

## Words

| Word         | Meaning                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Unit         | Work the runner can run. The app gives each unit an id, a run policy and a factory.                                               |
| Unit id      | The app's key for a unit, unique within a runner.                                                                                 |
| Factory      | Builds a fresh unit for each run, so a run's configuration is fixed from start to end. A factory that fails is a failed run.      |
| Run          | One start-to-end of a unit, on its own OS thread and tokio runtime.                                                               |
| Run state    | `Starting`, `Running` or `Stopped`.                                                                                               |
| Stop reason  | Why a run stopped. See Stop reasons.                                                                                              |
| Detail       | A unit's own status, of a type the app chooses. The unit reports it during a run, and it is cleared when the run ends.            |
| Unit status  | What the runner reports for a unit: the run state, the stop reason and error, when the run started running, and the detail.       |
| Run policy   | When the app wants a unit to run: `Off`, `WhileOpen`, `Until { at }` or `Always`.                                                 |
| Open         | Desktop: a window of the app is open, minimized included. Mobile: the app is in the foreground.                                   |
| Grace period | How long a `WhileOpen` unit keeps running after the app closes: 2 minutes.                                                        |
| Keep-alive   | The one background-service task that keeps the app alive while units run. Units don't run inside it.                              |
| Revocation   | The platform ending the keep-alive task. Units stay stopped until the app opens, a policy is set, or the keep-alive starts again. |
| Runner       | `UnitRunner`: holds the units, reconciles their runs with their policies, and starts and stops the keep-alive.                    |

## The contract

```rust
pub trait Unit: Send + 'static {
    /// The unit's own status, e.g. a connection's liveness or a sync's progress.
    type Detail: Clone + Send + Sync + 'static;

    /// Run until `ctx.shutdown()` is cancelled, or fail.
    fn run(self, ctx: RunContext<Self::Detail>)
        -> impl Future<Output = anyhow::Result<()>> + Send;
}

impl<D> RunContext<D> {
    pub fn unit_id(&self) -> &UnitId;
    pub fn shutdown(&self) -> &CancellationToken;
    pub fn announce_running(&self);      // Starting → Running
    pub fn set_detail(&self, detail: D);
}

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    pub fn new(start_config: StartConfig) -> Self;
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
    pub fn statuses(&self) -> UnitStatuses<D>; // BTreeMap<UnitId, UnitStatus<D>>
    pub fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>>;
}

pub struct UnitStatus<D> {
    pub run_state: RunState, // Starting | Running | Stopped { last_stop: Option<RunStop> }
    pub running_since: Option<DateTime<Utc>>,
    pub detail: Option<D>,
}
pub struct RunStop { pub reason: StopReason, pub error: Option<String>, pub stopped_at: DateTime<Utc> }
pub enum StopReason {
    PolicyInactive,
    Replaced,
    Removed,
    StoppedForRestart,
    EndedOnItsOwn,
    KeepAliveRevoked { platform_reason: PlatformStopReason },
}
```

The app builds the runner before the Tauri builder and registers its two
plugins: `background_service_plugin()` (the keep-alive) and
`lifecycle_plugin()` (whether the app is open, its resumes, and starting and
stopping the keep-alive), next to `tauri-plugin-notification`. `subscribe()`
always holds every unit's current status; a slow reader sees the latest
statuses, not every step. A new unit is `Stopped` with no last stop until its
first run.

One runner has one `Detail` type. An app with several kinds of unit makes its
`Detail` an enum.

**The app pushes; the runner never pulls.** At setup the app reads its own
registry and calls `set_unit` for each unit. Its commands write the registry,
then call `set_unit_policy` or `remove_unit`. The runner never reads or writes
the app's storage, and it never changes a policy. An expired `Until` stays
exactly as the app set it. For the app's registry, a `RunPolicy` serializes as
`{"kind":"off"}`, `{"kind":"whileOpen"}`,
`{"kind":"until","at":"2026-10-06T17:00:00Z"}` or `{"kind":"always"}`, and
decoding refuses unknown kinds and fields.

`set_unit` on a unit that is already set replaces its policy and factory: a run
of the old definition stops, and the unit starts again from the new factory if
it should run. `remove_unit` stops the unit, waits for its run to end, and
forgets it, status included. Run shutdown is bounded (see Runs), so
`remove_unit` always finishes. `set_unit_policy` and `remove_unit` for a unit
that was never set are logged and ignored.

## Runs

- **Isolation.** Each run gets its own OS thread and multi-thread tokio runtime.
  When the unit's future returns, the thread shuts the runtime down with a
  bounded `shutdown_timeout` (`RUN_RUNTIME_SHUTDOWN_TIMEOUT`, 5 s), which
  cancels every task the unit spawned. That is what keeps units from sharing
  anything: whatever a unit starts lives and dies with its run. Shutdown happens
  on the thread, never inside an async context. The factory runs on the run's
  thread too.
- **Panics.** A panic, in the unit or its factory, is caught on the thread and
  becomes the run's error.
- **Run gate.** Each unit has its own run gate. A run waits at it until the
  unit's previous run has ended and published `Stopped`. So a unit's run state
  never goes backwards, and two runs of one unit never overlap. Units never wait
  for each other. A run asked to stop while it waits never starts and publishes
  nothing: the unit's status stays as its last run left it, or never run for a
  unit that hasn't run yet. Statuses report runs that happened.
- **Generations.** Every run and every scheduled restart gets a generation
  number. A late event about one (a restart timer firing, a run ending) whose
  generation no longer matches the unit's is stale and ignored.
- **States.**
  - `Starting` is published when the run begins.
  - `Running` is published when the unit calls `announce_running()`.
  - `Stopped` is published once the runtime is gone, with the stop reason and,
    for a failure, the error as its `{:#}` anyhow chain. The runner has
    recorded the end (and scheduled any restart) by then, so a
    `set_unit_policy` the app makes on seeing `Stopped` always cancels that
    restart.
  - The detail is cleared at both ends of the run. Once `Stopped` is
    published, nothing a leftover clone of the run's `RunContext` reports
    lands.

## Stop reasons

| Reason              | Why the run stopped                                                                                                | What follows                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `PolicyInactive`    | The unit's policy stopped being active: the app set another policy, an `Until` ran out, or the grace period ended. | It starts again once its policy is active.                                |
| `Replaced`          | The app set the unit again.                                                                                        | The new definition starts once this run has ended, if it should run.      |
| `Removed`           | The app removed the unit.                                                                                          | The runner forgets the unit once this run has ended.                      |
| `StoppedForRestart` | The runner restarted every running unit on an iOS resume.                                                          | It starts again once this run has ended, with no delay, if it should run. |
| `EndedOnItsOwn`     | The unit returned, failed, panicked, or its factory failed.                                                        | It restarts after `RESTART_DELAY` if it should still run.                 |
| `KeepAliveRevoked`  | The platform ended the keep-alive task.                                                                            | It stays stopped until the revocation is cleared (see The keep-alive).    |

A run keeps the first reason it was stopped for.

## Reconciling

A unit **should run** when its policy is active and the keep-alive isn't
revoked:

| Policy         | Active                                                                        |
| -------------- | ----------------------------------------------------------------------------- |
| `Off`          | never                                                                         |
| `WhileOpen`    | while the app is open, and for `WHILE_OPEN_GRACE` (2 minutes) after it closes |
| `Until { at }` | while `at` is ahead of the wall clock                                         |
| `Always`       | always                                                                        |

So a `WhileOpen` unit keeps running for 2 minutes after the app closes. The
grace period is measured on the wall clock.

A reconcile pass starts every unit that should run and isn't running, and stops
every unit that is running but shouldn't be. There is no cap on how many units
run at once. Units start without waiting for the keep-alive to start: it only
keeps the app alive in the background.

**Open.** On a desktop, the lifecycle plugin counts the app's windows as they
are created and destroyed. On a phone, it follows the windows' `Suspended` and
`Resumed` events; `RunEvent::Resumed` isn't used, as tauri-runtime-wry raises it
on an event-loop poll, not when the app comes back.

The runner reconciles:

- on `set_unit`, `set_unit_policy` and `remove_unit`
- when the app opens or closes, and when a grace period ends
- at the next wall-clock deadline (an `Until` or a grace period running out),
  and at least every `WALL_CLOCK_RECONCILE_INTERVAL` (10 s). `tokio::time`
  runs on the monotonic clock, which stops while a laptop sleeps, so a long
  sleep alone would let a unit outlive its `Until`. Tauri raises no system
  resume on a desktop, so the first interval after waking catches what ran out
  during the sleep. A phone's app resume is the window's `Resumed`, which also
  opens the app.
- when the keep-alive starts or ends

## Restart on failure

A run that ends on its own while its unit should still run is restarted after a
fixed delay, `RESTART_DELAY` (5 s). That covers a run that fails, and a run
that returns `Ok` without being asked to stop. Runs the runner stopped itself,
and runs stopped by a revocation, never wait out that delay. A run stopped for
a restart starts again as soon as it has ended.

Calling `set_unit_policy` (even with the unchanged policy) cancels a pending
restart and starts the unit at once if it should run. A unit waiting out its
delay still should run, so it keeps the keep-alive running.

## The keep-alive: one background task for every unit

The runner uses `tauri-plugin-background-service`, and registers exactly one
`BackgroundService` for the whole app, however many units there are. That
service's task is the **keep-alive**: an Android foreground service or an iOS
background task that keeps the process alive while units run. Its `run()` tells
the runner it started, and waits until the plugin shuts it down. Units don't run
inside that task; they run on their own threads (see Runs).

The runner keeps a ledger of the keep-alive. Starting and stopping the task are
async, and the plugin can also start it itself (boot recovery, an OS restart).
So the runner numbers each task as it starts, and remembers which one it asked
to stop, so that task's end counts as its own. Any other end of the current task
is a **revocation**: the platform ended it. After a revocation, units stay
stopped until the app opens again, the app sets a policy, or the keep-alive
starts again. That way the runner doesn't fight the OS or the user.

- **Starting and stopping it.** The runner starts the service when a unit should
  run, and stops it when none should, one plugin call at a time. A start the
  plugin refuses is logged and tried again when the runner's demand next
  changes; units run either way. Its own stops carry `AppStop`, a stop reason
  that the plugin never uses itself, so they are never mistaken for platform
  stops. The runner starts and stops the keep-alive from the moment the app's
  event loop is ready (`RunEvent::Ready`), which follows the app's `setup()`,
  so a keep-alive the platform started at launch is judged once the app has
  set its units.
- **Starts the platform makes.** The plugin or the OS may start the service
  itself: an iOS background task, or the plugin's recovery. That run just tells
  the runner the keep-alive started, and the runner reconciles. The plugin
  takes its service factory before the app's `setup()`, so the runner is built
  before the Tauri builder and passed to it. A unit the app hasn't set yet
  starts when the app sets it. Nothing waits on an undecided value.
- **Why it ended.** The service's task sees only its shutdown token. The plugin
  names the reason in its `background-service://event` once the task has
  returned, so the task waits up to `KEEP_ALIVE_END_REASON_WAIT` (1 s) for
  that event before it reports the end. A reason that doesn't come in time, or
  that the runner doesn't know, is `PlatformStopReason::Unknown`.
- **Revocation.** When the platform revokes the keep-alive, every running unit
  stops with `KeepAliveRevoked` and the platform's reason. Examples: Android's
  foreground-service time limit, the Stop action on Android's notification, iOS
  background time running out, or the app quitting. Those units are not
  restarted until the revocation is cleared. On a phone, that usually means
  when the app returns to the foreground: opening the app, like the app setting
  a policy, lets the runner start the keep-alive again.
- **iOS resume.** On iOS, a resume restarts every running unit. A suspended
  app's connections may be dead while its runs still report `Running`.
- **Notification permission.** Before its first start, the runner asks for
  notification permission if the OS has never asked. The plugin's own start
  asks too, and on Android a second ask while the first is on screen reads as
  a refusal.
- **Android.** The plugin's persistent foreground-service notification, with the
  start config's label, covers every unit.

## What the app does

- It stores its units and their policies, and decides what each unit is.
- It owns its wire. The runner hands it statuses and their changes, and the app
  emits its own events and answers its own commands from them.
- It posts its own notifications, such as stops, failures and anything carried
  in a unit's detail, from the statuses.
- It configures the plugin: the start config, the Android manifest and the iOS
  background modes.

## Deliberately not here

- A cap on how many units run at once.
- Backoff, restart limits or other restart strategies; a failed run restarts
  after a fixed delay.
- Dependencies between units, or an order for starting them.
- The plugin's desktop OS-service (daemon) mode.
- Notification text, and any wire format.
