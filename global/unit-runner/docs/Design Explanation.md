# Unit Runner — Design Explanation

What the runner is for, the words it uses, and how it starts, watches, restarts
and ends a unit's runs.

## What it is

`unit-runner` runs an app's long-lived background work. Each piece of work is
a **unit**: something that runs until it is asked to stop, or fails. The app
tells the runner which units exist and when each should run. The runner then:

- starts and stops units to match their run policies
- restarts units that fail
- asks the platform to keep the app alive in the background while any unit
  runs
- reports each unit's status

The runner knows nothing about what a unit does. A unit that serves HTTP through
a tunnel with its own TLS is as opaque to it as one that syncs a folder.

## Two crates

The runner is split in two:

- **`unit-runner`** (this crate) holds everything that decides: units, run
  policies, statuses and stop reasons, the reconcile, runs and restarts, and
  the keep-alive ledger. It has no Tauri dependency.
- **`tauri-unit-runner`** binds it to Tauri: the keep-alive as
  `tauri-plugin-background-service`'s one service, and whether the app is open
  from its window events, as two plugins. It re-exports every public type
  here. Its
  [Design Explanation](../../tauri-unit-runner/docs/Design%20Explanation.md)
  covers the Tauri side.

The split exists so an app's domain crates can define units and store run
policies without depending on Tauri. They build and test against
`unit-runner` alone, with no GTK or webview in the build. Only the app's Tauri
crate needs `tauri-unit-runner`.

## Words

| Word                | Meaning                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Unit                | Work the runner can run. The app gives each unit an id, a run policy and a factory.                                               |
| Unit id             | The app's key for a unit, unique within a runner.                                                                                 |
| Factory             | Builds a fresh unit for each run, so a run's configuration is fixed from start to end. A factory that fails is a failed run.      |
| Run                 | One start-to-end of a unit, on its own OS thread and tokio runtime.                                                               |
| Run state           | `Starting`, `Running` or `Stopped`.                                                                                               |
| Stop reason         | Why a run stopped. See Stop reasons.                                                                                              |
| Detail              | A unit's own status, of a type the app chooses. The unit reports it during a run, and it is cleared when the run ends.            |
| Unit status         | What the runner reports for a unit: the run state, the stop reason and error, when the run started running, and the detail.       |
| Run policy          | When the app wants a unit to run: `Off`, `WhileOpen`, `Until { at }` or `Always`.                                                 |
| Open                | Desktop: a window of the app is open, minimized included. Mobile: the app is in the foreground. The host tells the runner.        |
| Grace period        | How long a `WhileOpen` unit keeps running after the app closes: 2 minutes.                                                        |
| Keep-alive          | The one platform task that keeps the app alive while units run. Units don't run inside it.                                        |
| Revocation          | The platform ending the keep-alive task. Units stay stopped until the app opens, a policy is set, or the keep-alive starts again. |
| Runner              | `UnitRunnerCore`: holds the units, reconciles their runs with their policies, and asks for the keep-alive.                        |
| Host                | What binds the runner to a platform: `tauri-unit-runner`'s `UnitRunner` in an app, a fake in tests.                               |
| Keep-alive platform | The port a host implements to start and stop the keep-alive task: `KeepAlivePlatform`.                                            |

## The contract

```rust
pub trait Unit: Send + 'static {
    /// The unit's own status, e.g. a connection's liveness or a sync's progress.
    type Detail: Clone + Send + Sync + 'static;

    /// Run until `ctx.shutdown_token()` is cancelled, or fail.
    fn run(self, ctx: RunContext<Self::Detail>)
        -> impl Future<Output = anyhow::Result<()>> + Send;
}

impl<D> RunContext<D> {
    pub fn unit_id(&self) -> &UnitId;
    pub fn shutdown_token(&self) -> &CancellationToken;
    pub fn announce_running(&self);      // Starting → Running
    pub fn set_detail(&self, detail: D);
}

impl<D: Clone + Send + Sync + 'static> UnitRunnerCore<D> {
    pub fn new(runtime: Handle, clock: Arc<dyn WallClock>) -> Arc<Self>;

    // What the app calls, through its host's runner.
    pub fn set_unit<U: Unit<Detail = D>>(
        self: &Arc<Self>,
        unit_id: UnitId,
        policy: RunPolicy,
        factory: impl Fn() -> anyhow::Result<U> + Send + Sync + 'static,
    );
    pub fn set_unit_policy(self: &Arc<Self>, unit_id: &UnitId, policy: RunPolicy);
    pub async fn remove_unit(self: &Arc<Self>, unit_id: &UnitId);
    pub fn statuses(&self) -> UnitStatuses<D>; // BTreeMap<UnitId, UnitStatus<D>>
    pub fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>>;

    // What the host calls.
    pub fn start_keep_alive_sync(self: &Arc<Self>, platform: Arc<dyn KeepAlivePlatform>);
    pub fn set_app_open(self: &Arc<Self>, open: bool);
    pub fn restart_running_units(self: &Arc<Self>);
    pub fn keep_alive_started(self: &Arc<Self>) -> KeepAliveId;
    pub fn keep_alive_ended(
        self: &Arc<Self>,
        id: KeepAliveId,
        platform_reason: Option<PlatformStopReason>,
    );
    pub fn runtime(&self) -> &Handle;
}

pub trait KeepAlivePlatform: Send + Sync + 'static {
    fn start(&self) -> KeepAliveOperation<'_>; // a task already running counts as started
    fn stop(&self) -> KeepAliveOperation<'_>;  // with the runner's own stop reason
}

pub trait WallClock: Send + Sync + 'static {
    fn now(&self) -> DateTime<Utc>; // `SystemClock` in an app
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

`subscribe()` always holds every unit's current status; a slow reader sees the
latest statuses, not every step. A new unit is `Stopped` with no last stop
until its first run.

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

**The host binds.** The runner learns about the platform only through its host.
The host tells it when the app opens or closes (`set_app_open`), when every
running unit should restart (`restart_running_units`), and when a keep-alive
task starts and ends (`keep_alive_started`, `keep_alive_ended`). It hands the
runner its `KeepAlivePlatform` once the platform can take its first start
(`start_keep_alive_sync`). Until then the runner's demand for the keep-alive
waits; units run either way.

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
| `StoppedForRestart` | The host restarted every running unit, as the Tauri host does on an iOS resume.                                    | It starts again once this run has ended, with no delay, if it should run. |
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
grace period is measured on the wall clock. The app starts out closed with no
grace period, so a `WhileOpen` unit starts once the host first reports the app
open.

A reconcile pass starts every unit that should run and isn't running, and stops
every unit that is running but shouldn't be. There is no cap on how many units
run at once. Units start without waiting for the keep-alive to start: it only
keeps the app alive in the background.

The runner reconciles:

- on `set_unit`, `set_unit_policy` and `remove_unit`
- when the app opens or closes, and when a grace period ends
- at the next wall-clock deadline (an `Until` or a grace period running out),
  and at least every `WALL_CLOCK_RECONCILE_INTERVAL` (10 s). `tokio::time`
  runs on the monotonic clock, which stops while a laptop sleeps, so a long
  sleep alone would let a unit outlive its `Until`. The first interval after
  waking catches what ran out during the sleep, without the host's help.
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

## The keep-alive: one platform task for every unit

The runner asks the platform for exactly one keep-alive task for the whole app,
however many units there are: on a phone, an Android foreground service or an
iOS background task that keeps the process alive while units run. Units don't
run inside that task; they run on their own threads (see Runs).

The runner keeps a ledger of the keep-alive. Starting and stopping the task are
async, and the platform can also start it itself (boot recovery, an OS
restart). So the runner numbers each task as it starts, and remembers which one
it asked to stop, so that task's end counts as its own. Any other end of the
current task is a **revocation**: the platform ended it. After a revocation,
units stay stopped until the app opens again, the app sets a policy, or the
keep-alive starts again. That way the runner doesn't fight the OS or the user.

- **Starting and stopping it.** The runner starts the task when a unit should
  run, and stops it when none should, one `KeepAlivePlatform` call at a time.
  A call that fails is logged and tried again when the runner's demand next
  changes; units run either way.
- **Starts the platform makes.** Whoever starts the task, the task tells the
  runner it started, and the runner reconciles. A keep-alive the platform
  started with nothing to run is stopped. A unit the app hasn't set yet starts
  when the app sets it. Nothing waits on an undecided value.
- **Revocation.** When the platform revokes the keep-alive, every running unit
  stops with `KeepAliveRevoked` and the platform's reason, a
  `PlatformStopReason`. Examples: Android's foreground-service time limit, the
  Stop action on Android's notification, iOS background time running out, or
  the app quitting. Those units are not restarted until the revocation is
  cleared. On a phone, that usually means when the app returns to the
  foreground: opening the app, like the app setting a policy, lets the runner
  start the keep-alive again.

## What the app does

- It stores its units and their policies, and decides what each unit is.
- It owns its wire. The runner hands it statuses and their changes, and the app
  emits its own events and answers its own commands from them.
- It posts its own notifications, such as stops, failures and anything carried
  in a unit's detail, from the statuses.
- It registers its host, and configures the host's platform.

## Deliberately not here

- A cap on how many units run at once.
- Backoff, restart limits or other restart strategies; a failed run restarts
  after a fixed delay.
- Dependencies between units, or an order for starting them.
- Notification text, and any wire format.
- Any platform: a host binds one.
