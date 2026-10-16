# Unit Runner — Design Explanation

What `UnitRunner` is for, the words it uses, and how it starts, watches,
restarts and ends a unit's runs.

## What it is

`unit-runner-rust` runs an app's long-lived background work. Each piece of work is a
**unit**: something that runs until it is asked to stop, or fails. The app tells
`UnitRunner` which units exist and when each should run. `UnitRunner` then:

- starts and stops units to match their run policies
- restarts units that fail
- asks the platform for a background session, which keeps the app alive in
  the background, while any unit runs
- reports each unit's status

`UnitRunner` knows nothing about what a unit does. A unit that serves HTTP
through a tunnel with its own TLS is as opaque to it as one that syncs a folder.

## Two crates

It is split into two crates:

- **`unit-runner-rust`** (this crate) holds everything that decides: units, run
  policies, statuses and stop reasons, starting and stopping runs per policy,
  runs and restarts, and
  the session ledger. It has no Tauri dependency.
- **`tauri-unit-runner-rust`** binds it to Tauri: the background session as
  `tauri-plugin-background-service`'s one service, and whether the app is
  present from its window events, as two plugins. It re-exports every public
  type here. Its [Design
  Explanation](../../tauri-unit-runner-rust/docs/Design%20Explanation.md) covers the
  Tauri side.

The split exists so an app's domain crates can define units and store run
policies without depending on Tauri. They build and test against
`unit-runner-rust` alone, with no GTK or webview in the build. Only the app's Tauri
crate needs `tauri-unit-runner-rust`.

## Words

| Word                        | Meaning                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                        | Work `UnitRunner` can run. The app gives each unit an id, a run policy and a factory.                                                                |
| Unit id                     | The app's key for a unit, unique within a `UnitRunner`.                                                                                              |
| Factory                     | Builds a fresh unit for each run, so a run's configuration is fixed from start to end. A factory that fails is a failed run.                         |
| Run                         | One start-to-end of a unit, on its own OS thread and tokio runtime.                                                                                  |
| Run state                   | `Starting`, `Running` or `Stopped`.                                                                                                                  |
| Stop reason                 | Why a run stopped. See Stop reasons.                                                                                                                 |
| Detail                      | A unit's own status, of a type the app chooses. The unit reports it during a run, and it is cleared when the run ends.                               |
| Unit status                 | What `UnitRunner` reports for a unit: the run state, the stop reason and error, when the run started running, and the detail.                        |
| Run policy                  | When the app wants a unit to run: `Off`, `WhileOpen`, `Until { at }` or `Always`.                                                                    |
| Present                     | Desktop: a window of the app is open, minimized included. Mobile: the app is in the foreground. The host tells `UnitRunner`. The opposite is absent. |
| Grace period                | How long a `WhileOpen` unit keeps running after the app becomes absent: 2 minutes.                                                                   |
| Background session          | The one platform task that keeps the app alive in the background while units run. Units don't run inside it.                                         |
| Ended by platform           | The platform ending the background session. Runs are discouraged until the app becomes present, a policy is set, or a session starts again.          |
| No longer needed            | How `UnitRunner` ends the background session once no unit should run.                                                                                |
| Runner                      | `UnitRunner`: holds the units, starts and stops their runs per their policies, and asks for the background session.                                  |
| Host                        | What binds `UnitRunner` to a platform: `tauri-unit-runner-rust`'s `TauriUnitRunner` in an app, a fake in tests.                                      |
| Background session platform | The port a host implements to start and end the background session: `BackgroundSessionPlatform`.                                                     |
| Background session length   | How long the platform's background session can keep the app alive after it becomes absent: `AsLongAsNeeded` or `GracePeriod`. The host chooses it.   |

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

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    pub fn new(
        runtime: Handle,
        clock: Arc<dyn WallClock>,
        background_session_length: BackgroundSessionLength,
    ) -> Arc<Self>;

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
    pub fn attach_background_session_platform<P: BackgroundSessionPlatform>(
        self: &Arc<Self>,
        platform: Arc<P>,
    );
    pub fn set_app_presence(self: &Arc<Self>, presence: Presence);
    pub fn restart_running_units(self: &Arc<Self>);
    pub fn session_started(self: &Arc<Self>) -> SessionId;
    pub fn session_ended(
        self: &Arc<Self>,
        id: SessionId,
        platform_reason: Option<PlatformStopReason>,
    );
    pub fn runtime(&self) -> &Handle;
}

pub trait BackgroundSessionPlatform: Send + Sync + 'static {
    // Each resolves once the platform has taken the request, before the
    // session reports its start or end.
    fn request_session_start(&self) -> impl Future<Output = anyhow::Result<()>> + Send; // a session already running counts as started
    fn request_session_end(&self) -> impl Future<Output = anyhow::Result<()>> + Send;   // with `UnitRunner`'s own stop reason
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
    SessionEndedByPlatform { platform_reason: PlatformStopReason },
}
```

`subscribe()` always holds every unit's current status; a slow reader sees the
latest statuses, not every step. `subscribe_stops()` reports every step that
matters to a reader that acts on stops, such as one that notifies: each run's
stop once, as a `RunStopped` with the unit id, the `RunStop` its status now
holds, and whether the run had announced running. It is a broadcast
`RUN_STOPS_CAPACITY` (64) deep; a reader that falls further behind is told how
many stops it missed. `subscribe_returns()` reports each return to the
foreground, when the app becomes present after being absent, having been
present before (not its first window or first time in the foreground, nor
leaving the background on Android), as an `AppReturn`: the statuses, as of that
moment and before any run the return starts, of the units whose run carries on
across it, in progress and not asked to stop (`carried_on`), and of the units
the return resumes, each that should run now but whose run doesn't carry on
(`resumed`). A run the host restarts for the return, as the Tauri host does
every running unit's on iOS, is resumed, its status still its old run's until
that run stops. A unit that shouldn't run is in neither. A slow reader sees the
latest return.

A new unit is `Stopped` with no last stop until its first run.

One `UnitRunner` has one `Detail` type. An app with several kinds of unit makes
its `Detail` an enum.

**The app pushes; `UnitRunner` never pulls.** At setup the app reads its own
registry and calls `set_unit` for each unit. Its commands write the registry,
then call `set_unit_policy` or `remove_unit`. `UnitRunner` never reads or writes
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

**The host binds.** `UnitRunner` learns about the platform only through its
host. The host tells it the app's presence (`set_app_presence`): absent,
present, or present in the background, where the platform treats a present
app as in the background so only a background session keeps it alive; when
every running unit should restart (`restart_running_units`), and when a
background session starts and ends (`session_started`, `session_ended`). It
hands `UnitRunner` its `BackgroundSessionPlatform` once, when the platform can
take its first request (`attach_background_session_platform`); from then on
`UnitRunner` asks it for session starts and ends as its session demand changes.
Until then `UnitRunner`'s demand for a background session waits; units run
either way.

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
- **Generations.** Every run gets a generation number. A late end of a run
  whose generation no longer matches the unit's current run is stale and
  ignored. A pending restart's timer is cancelled whenever the restart is
  dropped (cancelled, replaced, or its unit removed), and checks that under
  `UnitRunner`'s state lock, so a stale timer never restarts a unit.
- **States.**
  - `Starting` is published when the run begins.
  - `Running` is published when the unit calls `announce_running()`.
  - `Stopped` is published once the runtime is gone, with the stop reason and,
    for a failure, the error as its `{:#}` anyhow chain. `UnitRunner` has
    recorded the end (and scheduled any restart) by then, so a
    `set_unit_policy` the app makes on seeing `Stopped` always cancels that
    restart.
  - The detail is cleared at both ends of the run. Once `Stopped` is
    published, nothing a leftover clone of the run's `RunContext` reports
    lands.

## Stop reasons

| Reason                   | Why the run stopped                                                                                                      | What follows                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `PolicyInactive`         | The unit's policy stopped wanting it running: the app set another policy, an `Until` ran out, or the grace period ended. | It starts again once its policy wants it running.                         |
| `Replaced`               | The app set the unit again.                                                                                              | The new definition starts once this run has ended, if it should run.      |
| `Removed`                | The app removed the unit.                                                                                                | `UnitRunner` forgets the unit once this run has ended.                    |
| `StoppedForRestart`      | The host restarted every running unit, as the Tauri host does when an iOS app returns to the foreground.                 | It starts again once this run has ended, with no delay, if it should run. |
| `EndedOnItsOwn`          | The unit returned, failed, panicked, or its factory failed.                                                              | It restarts after the restart delay if it should still run.               |
| `SessionEndedByPlatform` | The platform ended the background session.                                                                               | It stays stopped until that is cleared (see The background session).      |

A run keeps the first reason it was stopped for.

## Starting and stopping runs per policy

A unit **should run** when its policy wants it running and the platform's end
of the background session doesn't discourage runs:

| Policy         | Wants the unit running                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| `Off`          | never                                                                                    |
| `WhileOpen`    | while the app is present, and for `WHILE_OPEN_GRACE` (2 minutes) after it becomes absent |
| `Until { at }` | while `at` is ahead of the wall clock                                                    |
| `Always`       | always                                                                                   |

So a `WhileOpen` unit keeps running for 2 minutes after the app becomes absent.
The grace period is measured on the wall clock. The app starts out absent with
no grace period, so a `WhileOpen` unit starts once the host first reports the
app present.

On a platform whose background session lasts only the grace period (see
Background session length), no unit should run once the grace period has
ended. While the app is absent, `Always` and `Until` then want a unit running
only for the grace period, as `WhileOpen` does; while it is present, every
policy means what the table says. A unit stopped as the grace period ends
stops with `PolicyInactive`.

`start_and_stop_runs_per_policy` starts every unit that should run and isn't
running, and stops every unit that is running but shouldn't be. There is no cap
on how many units run at once. Units start without waiting for the background
session to start: it only keeps the app alive in the background.

`UnitRunner` starts and stops runs per policy:

- on `set_unit`, `set_unit_policy` and `remove_unit`
- when the app becomes present or absent, and when a grace period ends
- at the next wall-clock deadline (an `Until` or a grace period running out),
  and at least every `START_AND_STOP_RUNS_PER_POLICY_INTERVAL` (10 s).
  `tokio::time` runs on the monotonic clock, which stops while a laptop sleeps,
  so a long sleep alone would let a unit outlive its `Until`. The first interval
  after waking catches what ran out during the sleep, without the host's help.
- when a background session starts or ends

## Restart on failure

A run that ends on its own while its unit should still run is restarted after
the restart delay. That covers a run that fails, and a run that returns `Ok`
without being asked to stop. Runs `UnitRunner` stopped itself, and runs stopped
by the platform's end of the background session, never wait out that delay. A
run stopped for a restart starts again as soon as it has ended.

The restart delay backs off per unit. The first restart in a row is at once,
so a one-off fault recovers without waiting. The second waits
`FIRST_UNIT_RESTART_BACKOFF` (5 s), and each after it twice as long as the one
before, up to `MAX_UNIT_RESTART_BACKOFF` (5 minutes): 0 s, 5 s, 10 s, 20 s, and
so on. So a unit that can never come up, such as a server whose configuration
can't be built, settles at one attempt every 5 minutes. The count of restarts
in a row starts over:

- when a run that had been running for `STABLE_UNIT_UPTIME` (2 minutes) ends,
  so a unit that stayed up and later failed restarts at once again, while one
  that comes up and fails soon after keeps backing off;
- while the unit shouldn't run (its policy is inactive, the platform ended the
  background session, or it is being removed), so failures don't carry over
  into the next time it should run;
- on every fresh instruction: `set_unit` and `set_unit_policy` for the unit,
  and `restart_running_units` and the app becoming present for every unit.

A fresh instruction (`set_unit_policy` even with the unchanged policy
included) also cancels a pending restart, so the unit starts at once if it
should run. A unit waiting out its delay still should run, so it keeps a
background session wanted. The delay runs on `tokio::time` from the run's end, so time a laptop spends asleep
doesn't count toward it.

## The background session: one platform task for every unit

`UnitRunner` asks the platform for exactly one background session for the whole
app, however many units there are: on a phone, an Android foreground service or
an iOS background task that keeps the process alive while units run. Units
don't run inside the session; they run on their own threads (see Runs).

`UnitRunner` keeps a ledger of the background session. Its state is one of: no
session; ended by the platform; running; or ending as no longer needed. Starting
and ending a session are async, and the platform can also start one itself (boot
recovery, an OS restart). So `UnitRunner` numbers each session as it starts, and
marks the one it ends as **no longer needed**, so that session's end counts as
its own. Any other end of the running session is the platform's: the session is
**ended by the platform**. Runs are then discouraged until the app becomes
present again,
the app sets a policy, or a session starts again. That way `UnitRunner` doesn't
fight the OS or the user. A late end of a session that is no longer the current
one is stale, and changes nothing.

- **Starting and ending it.** `UnitRunner` starts a session when one is wanted
  (a unit should run; see Background session length), and ends it when none
  is, one `BackgroundSessionPlatform` call at a
  time. It decides under its lock and never awaits there, so it only publishes
  its session demand; one task follows the latest demand and makes the call it
  plans, skipping demands replaced in the meantime. A call resolves once the
  platform has taken the request; the session reports its start and end
  itself. While a session is ending, `UnitRunner`
  waits for its end before starting another, even if a unit should run again.
  A call that fails is logged and tried again when `UnitRunner`'s demand next
  changes; units run either way.
- **Starts the platform makes.** Whoever starts a session, the session tells
  `UnitRunner` it started, and `UnitRunner` starts and stops runs per policy. A
  session the platform started with nothing to run is ended. A unit the app
  hasn't set yet starts when the app sets it. Nothing waits on an undecided
  value.
- **Ended by the platform.** When the platform ends the background session,
  every running unit stops with `SessionEndedByPlatform` and the platform's
  reason, a `PlatformStopReason`. Examples: Android's foreground-service time
  limit, the Stop action on Android's notification, iOS background time running
  out, or the app quitting. Those units are not restarted until that is
  cleared. On a phone, that usually means when the app returns to the
  foreground: the app becoming present, like the app setting a policy, lets
  `UnitRunner`
  start a session again.

## Background session length

`UnitRunner` is built with the host's `BackgroundSessionLength`: how long the
platform's background session can keep the app alive after it becomes absent.

| Length           | A session is wanted                                                                                 | While the app is absent, a unit should run        | Host                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `AsLongAsNeeded` | while some unit should run                                                                          | as its policy says                                | a desktop, and iOS, which ends the session itself when its background time runs out |
| `GracePeriod`    | while the app isn't plainly present (absent, or present in the background) and some unit should run | only within the grace period, whatever its policy | Android with a `shortService`, which Android times out after 3 minutes              |

A `GracePeriod` session isn't started while the app is present: Android
would time it out with the app still on screen. So it is wanted only once the
app becomes absent, and its 2 minutes start as the grace period does. When the
grace period ends, every unit stops with `PolicyInactive` and `UnitRunner`
ends the session as no longer needed, so the session ends before the platform's
limit. When the app becomes present again, the session is no longer wanted, and
the units run without one.

An app present in the background wants a `GracePeriod` session too, though
it is present: no grace period runs, and every policy means what it says, so
only the platform's 3-minute limit ends that session. Ending it that way
discourages runs until the app is plainly present again.

## What the app does

- It stores its units and their policies, and decides what each unit is.
- It owns its wire. `UnitRunner` hands it statuses and their changes, and the
  app emits its own events and answers its own commands from them.
- It posts its own notifications, such as stops, failures and anything carried
  in a unit's detail, from the statuses.
- It registers its host, and configures the host's platform.

## Deliberately not here

- A cap on how many units run at once.
- Restart limits or other restart strategies: a unit whose runs keep failing
  keeps restarting, every `MAX_UNIT_RESTART_BACKOFF` at most, while it should run.
- Dependencies between units, or an order for starting them.
- Notification text, and any wire format.
- Any platform: a host binds one.
