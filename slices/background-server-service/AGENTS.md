# AGENTS.md — slices/background-server-service

The **background server service**: the Tauri host runs the Wildflower server
(`slices/wildflower-server`) through `tauri-plugin-background-service`, each
start on its own OS thread and tokio runtime behind a run gate, and watches it:
a status snapshot on the bridge, a restart from the page, and local
notifications for stops, tunnel traffic and tunnel drops. The page shows the
snapshot in a banner and on `/settings/server`. Read the
[Design Explanation](./docs/Design%20Explanation.md) before changing anything
here.

## Package roles

- **[`background-server-service-core`](./background-server-service-core/AGENTS.md)**
  — `BackgroundServerServiceBridge`: the `ServerServiceStatus` and
  `RestartServer` schemas, the contract the Rust mirror is pinned to. Pure.
- **[`background-server-service-react`](./background-server-service-react/AGENTS.md)**
  — the page side: the status store and the boot-stable handler that fills it,
  `ServerStatusBanner`, the `/settings/server` page, and the `RestartServer`
  sender.
- **`background-server-service-rust`** — no `tauri` dependency, so everything
  in it tests without GTK.
  - The serde mirror of the bridge (`bridge.rs`: `ServerServiceStatus`,
    `RestartServer`) with golden tests, and of the plugin's lifecycle events
    (`plugin_event.rs`).
  - `ServerHostContext::run_server` (`live_bindings/server_run.rs`): one run
    of the server behind the `RunGate`, on a dedicated runtime, publishing its
    `ServerRunState`. `tests/restart.rs` restarts the real server through it.
  - The notification decisions: the per-caller request coalescer, the stop
    notification per reason, the tunnel-drop detector, and what a foreground
    resume does.
  - Layout: the wire mirrors (`bridge.rs`, `plugin_event.rs`) at the crate
    root; `domain/` the run gate, `ServerRunState`, the foreground-resume rule
    and the notification decisions, testable without I/O; `live_bindings/` a
    server run bound to `wildflower-server-rust`, with its dedicated thread and
    runtime in `server_run/dedicated_runtime.rs`.
- **`background-server-service-tauri-rust`** — the glue: the plugin's
  `BackgroundService` impl (`WildflowerServerService`), asking for the
  notification permission, starting and restarting the service, the
  plugin-event and bridge listeners, the status emitter, and posting
  notifications and the native error dialog. Its tests pin the event
  mirror against the plugin's own serializer.
- **`background-server-service-android-rust`** — the Android headless-core
  shim, removed with #886: the JNI functions the plugin's `HeadlessBridge`
  calls in the host's library, and `mark_host_running`, the process-global
  flag `startCore` reads. It has no `tauri` dependency and tests on any target;
  the host links it on Android only.

`apps/wildflower-tauri` registers the notification and background-service
plugins, builds the `ServerHostContext` in `.setup()`, and hands it with the
service's start config (label and foreground-service type, from
`tauri-shared-config.json`) to `start_background_server_service`. It also owns
the mobile packaging: the plugin's `background-service` config in
`tauri.conf.json`, the Android manifest's overrides of the plugin's manifest,
the iOS background modes and `BGTask` identifiers, and the Tauri entry's
`configureRecovery` call, the one plugin command the webview may invoke.
Its Android `WildflowerApplication` points `HeadlessBridge.nativeLibName` at
the host's library, and `.setup()` marks the host running for the Android shim
before the service starts.
Its web entry also seeds the status handler into the transport, and passes the
banner and the Settings row for `/settings/server` to `wildflower-react`, which
mounts the route and provides the store.

`bridge-wire-golden.json`, at the slice root, holds the exact wire strings and
stop reasons both `-rust`'s golden tests and `-core`'s `bridge.test.ts` read.

## Layering

- **The server knows nothing of the service.** `wildflower-server-rust` exposes
  `set_up` / `WildflowerServer::serve` and the host-owned `ServerObservers`; this
  slice decides when a server runs and what the host does with what it reports.
- **Decisions in `-rust`, wiring in `-tauri-rust`.** A new notification rule or
  state goes in `-rust` with its tests; `-tauri-rust` only maps plugin events
  and Tauri calls onto it.
- **Every start goes through the run gate.** Don't start the server any other
  way: the gate is what keeps a restart from binding the port while the
  previous runtime is still shutting down.
- **A restart stops with `RESTART_STOP_REASON`**, so its stop half doesn't
  notify. Don't use that reason for anything else.
- **`-android-rust` is the workspace's one `unsafe_code` exception.** Its
  `[lints]` copy the workspace's with `unsafe_code` at `deny` instead of
  `forbid` (a test compares the two), and only each JNI export's
  `#[unsafe(no_mangle)]` allows it. Keep everything else in the crate safe, and
  its reports in `headless_core_report.rs`, where they are tested.
- **`startCore` accepts only once the host runs the server.** A start with no
  host in the process must fail, so the plugin's failure handling runs instead
  of a "running" notification with nothing behind it.
- **One start config.** Every start uses the `StartConfig` the host passes in,
  and the Tauri entry's `configureRecovery` reads the same
  `tauri-shared-config.json` entries. Change the foreground-service type there,
  and the host tests point at the plugin config and the Android manifest that
  must follow.
- **The page renders the latest snapshot and nothing else.** No client-side
  state machine: a store holds the last `ServerServiceStatus`, and the banner
  and page derive everything from it.
- **A wire change edits `bridge-wire-golden.json`, the TS schema and the serde
  mirror together.** Each side's tests read the shared file, so changing one
  side alone fails.

## References

- [Design Explanation](./docs/Design%20Explanation.md) — the flow, each
  decision, the wire, and what is not here.
- [wildflower-server AGENTS.md](../wildflower-server/AGENTS.md) — the server
  each run sets up and serves.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) and the
  [Wire Pinning How-To](../../docs/Messaging/Wire%20Pinning%20How-To.md) — the
  discipline `ServerServiceStatus` and `RestartServer` follow.
