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

| Word        | Meaning                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Work the runner can run. The app gives each unit an id, a run policy and a factory.                                          |
| Unit id     | The app's key for a unit, unique within a runner.                                                                            |
| Factory     | Builds a fresh unit for each run, so a run's configuration is fixed from start to end. A factory that fails is a failed run. |
| Run         | One start-to-end of a unit, on its own OS thread and tokio runtime.                                                          |
| Run state   | `Starting`, `Running` or `Stopped`.                                                                                          |
| Stop reason | Why a run stopped: the runner stopped it, it ended on its own (with or without an error), or the platform ended the lease.   |
| Detail      | A unit's own status, of a type the app chooses. The unit reports it during a run, and it is cleared when the run ends.       |
| Unit status | What the runner reports for a unit: the run state, the stop reason and error, when the run started running, and the detail.  |
| Run policy  | When the app wants a unit to run: `Off`, `WhileInUse`, `Until { at }` or `Always`.                                           |
| In use      | Desktop: a window of the app is open, minimized included. Mobile: the app is in the foreground.                              |
| Lease       | The one background-service task that keeps the app alive while units run.                                                    |
| Runner      | `UnitRunner`: holds the units, reconciles their runs with their policies, and holds the lease.                               |

## The contract

A sketch of the shape, not the final signatures:

```rust
pub trait Unit: Send + 'static {
    /// The unit's own status, e.g. a connection's liveness or a sync's progress.
    type Detail: Clone + Send + Sync + 'static;

    /// Run until `ctx.shutdown()` is cancelled, or fail.
    fn run(self, ctx: RunContext<Self::Detail>)
        -> impl Future<Output = anyhow::Result<()>> + Send;
}

impl<D> RunContext<D> {
    pub fn shutdown(&self) -> &CancellationToken;
    pub fn running(&self);               // Starting → Running
    pub fn set_detail(&self, detail: D);
}

impl<D> UnitRunner<D> {
    pub fn set<U: Unit<Detail = D>>(
        &self,
        id: UnitId,
        policy: RunPolicy,
        factory: impl Fn() -> anyhow::Result<U> + Send + Sync + 'static,
    );
    pub fn set_policy(&self, id: &UnitId, policy: RunPolicy);
    pub async fn remove(&self, id: &UnitId);
    pub fn statuses(&self) -> BTreeMap<UnitId, UnitStatus<D>>;
    pub fn subscribe(&self) -> /* each unit's status as it changes */;
}
```

One runner has one `Detail` type. An app with several kinds of unit makes its
`Detail` an enum.

**The app pushes; the runner never pulls.** At setup the app reads its own
registry and calls `set` for each unit. Its commands write the registry, then
call `set_policy` or `remove`. The runner never reads or writes the app's
storage, and it never changes a policy. An expired `Until` stays exactly as the
app set it.

`remove` stops the unit, waits for its run to end, and forgets it. Run shutdown
is bounded (see Runs), so `remove` always finishes.

## Runs

- **Isolation.** Each run gets its own OS thread and multi-thread tokio runtime.
  When the unit's future returns, the thread shuts the runtime down with a
  bounded `shutdown_timeout`, which cancels every task the unit spawned. That is
  what keeps units from sharing anything: whatever a unit starts lives and dies
  with its run. Shutdown happens on the thread, never inside an async context.
- **Panics.** A panic is caught on the thread and becomes the run's error.
- **Run gate.** Each unit has its own run gate. A run waits at it until the
  unit's previous run has ended and published `Stopped`. So a unit's run state
  never goes backwards, and two runs of one unit never overlap. Units never wait
  for each other.
- **States.**
  - `Starting` is published when the run begins.
  - `Running` is published when the unit calls `running()`.
  - `Stopped` is published once the runtime is gone, with the stop reason and,
    for a failure, the error as its `{:#}` anyhow chain.
  - The detail is cleared at both ends of the run.

## Reconciling

A unit **should run** when its policy is active and the runner holds the lease,
or can take it:

| Policy         | Active                                                                   |
| -------------- | ------------------------------------------------------------------------ |
| `Off`          | never                                                                    |
| `WhileInUse`   | while the app is in use, plus a grace period after it stops being in use |
| `Until { at }` | while `at` is ahead of the wall clock                                    |
| `Always`       | always                                                                   |

A reconcile pass starts every unit that should run and isn't running, and stops
every unit that is running but shouldn't be. There is no cap on how many units
run at once.

The runner reconciles:

- on `set`, `set_policy` and `remove`
- when the app goes in or out of use, and when a grace period ends
- on a short wall-clock interval, and on system and app resume. `tokio::time`
  runs on the monotonic clock, which stops while a laptop sleeps, so a long
  sleep alone would let a unit outlive its `Until`.
- when it gains or loses the lease

## Restart on failure

A run that ends on its own while its unit should still run is restarted after a
fixed delay. That covers a run that fails, and a run that returns `Ok` without
being asked to stop. The runner does not restart runs it stopped itself, or runs
that ended because the platform ended the lease.

Calling `set_policy` (even with the unchanged policy) cancels a pending restart
and starts the unit at once if it should run.

## The lease: one background task for every unit

The runner uses `tauri-plugin-background-service`, and registers exactly one
`BackgroundService` for the whole app, however many units there are. Its `run()`
holds the lease until the plugin shuts it down. Units don't run inside that
task; they run on their own threads (see Runs). The task only keeps the app
alive.

- **Taking and releasing it.** The runner starts the service when a unit should
  run, and stops it when none should. Its own stops carry a stop reason that the
  platform never uses, so they are never mistaken for platform stops.
- **Starts the platform makes.** The plugin or the OS may start the service
  itself: an iOS background task, or the plugin's recovery. That run just hands
  the runner the lease, and the runner reconciles. The plugin takes its service
  factory before the app's `setup()`, so the runner is built before the Tauri
  builder and passed to it. A unit the app hasn't set yet starts when the app
  sets it. Nothing waits on an undecided value.
- **The platform ending it.** When the platform ends the lease, every running
  unit stops with the platform's stop reason. Examples: iOS background time
  running out, the Stop action on Android's notification, or the app quitting.
  Those units are not restarted until the lease comes back. On a phone, that
  means when the app returns to the foreground.
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
