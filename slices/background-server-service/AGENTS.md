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
  - `ServerHost` and `ServerHostContext::run_server`
    (`live_bindings/server_run.rs`): what every run shares (the host's ports,
    the run gate, the run-state and tunnel channels), and one run of a
    server's config behind the `RunGate`, on a dedicated runtime, publishing
    its `ServerRunState` (from `shared-structures-rust`). `ServerToRun` is
    what the host publishes for the service's runs, and
    `run_published_server` waits for it and runs it, or ends at once when
    there is no server to run. `tests/restart.rs` restarts the real server,
    and switches servers, through them.
  - The notification decisions: the per-caller request coalescer, the stop
    notification per reason, the tunnel-drop detector, and what a foreground
    resume does.
  - Layout: the wire mirrors (`bridge.rs`, `plugin_event.rs`) at the crate
    root; `domain/` the run gate, the foreground-resume rule and the
    notification decisions, testable without I/O; `live_bindings/` a
    server run bound to `wildflower-server-rust`, with its dedicated thread and
    runtime in `server_run/dedicated_runtime.rs`.
- **`background-server-service-tauri-rust`** — the glue: the plugin's
  `BackgroundService` impl (`WildflowerServerService`), asking for the
  notification permission, starting, stopping and restarting the service
  (`ServerServiceHandle`), the plugin-event and bridge listeners, the status
  emitter, and posting notifications and the native error dialog. Its tests
  pin the event mirror against the plugin's own serializer.

`apps/wildflower-tauri` registers the notification and background-service
plugins, builds the `ServerHost` in `.setup()`, and attaches the glue with
`attach_background_server_service`, passing the service's start config (label
and foreground-service type, from `tauri-shared-config.json`); every setup path
attaches it. Which server runs is the servers slice's reconciler's choice, by
each server's run policy: the app's `ServerService` (`server_runner.rs`)
publishes that server's `ServerHostContext` as the `ServerToRun` and starts the
service through the handle, and to stop it publishes `ServerToRun::NoServer`,
stops the service and waits for the run to end. It also owns
the mobile packaging: the plugin's `background-service` config in
`tauri.conf.json`, the Android manifest's overrides of the plugin's manifest,
the iOS background modes and `BGTask` identifiers, and the Tauri entry's
`configureRecovery` call, the one plugin command the webview may invoke.
The workspace patches the plugin to our fork (see the Design Explanation's
"Plugin fork").
The Tauri webview mounts the base (`slices/servers`), which reads each
server's status from the servers slice's `server-status` event rather than
this slice's bridge snapshot.

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
- **The host stops the service with `HOST_STOP_REASON`**, for a restart's
  stop half and for a stop the base asked for, so neither notifies. Nothing
  else stops with it.
- **A run with no server to run ends at once.** A run the plugin or the OS
  starts on its own waits for the host to decide, and with
  `ServerToRun::NoServer` it logs the host's reason and ends, so nothing waits
  on a server that isn't coming. A foreground resume starts a stopped server
  only while one is published.
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
