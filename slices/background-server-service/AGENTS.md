# AGENTS.md — slices/background-server-service

The **background server service**: the Tauri host runs the Wildflower server
(`slices/wildflower-server`) through `tauri-plugin-background-service`, each
start on its own OS thread and tokio runtime behind a run gate, and watches it:
a status snapshot on the bridge, a restart from the page, and local
notifications for stops, tunnel traffic and tunnel drops. Read the
[Design Explanation](./docs/Design%20Explanation.md) before changing anything
here.

## Package roles

- **`background-server-service-rust`** — no `tauri` dependency, so everything
  in it tests without GTK.
  - The serde mirror of the bridge (`bridge.rs`: `ServerServiceStatus`,
    `RestartServer`) with golden tests, and of the plugin's lifecycle events
    (`plugin_event.rs`).
  - `ServerHostContext::run_server` (`server_run.rs`): one run of the server
    behind the `RunGate`, on a dedicated runtime, publishing its
    `ServerRunState`. `tests/restart.rs` restarts the real server through it.
  - The notification decisions: the per-caller request coalescer, the stop
    notification per reason, the tunnel-drop detector, and what a foreground
    resume does.
- **`background-server-service-tauri-rust`** — the glue: the plugin's
  `BackgroundService` impl (`WildflowerServerService`), starting and restarting
  the service, the plugin-event and bridge listeners, the status emitter, and
  posting notifications and the native error dialog. Its tests pin the event
  mirror against the plugin's own serializer.
- **`background-server-service-android-rust`** — the Android headless-core
  shim, removed with #886: the JNI functions the plugin's `HeadlessBridge`
  calls in the host's library, and `mark_host_running`, the process-global
  flag `startCore` reads. It has no `tauri` dependency and tests on any target;
  the host links it on Android only.

`apps/wildflower-tauri` registers the notification and background-service
plugins, builds the `ServerHostContext` in `.setup()`, attaches the glue, marks
itself running for the Android shim and starts the service. The plugin's
`background-service` config lives in its `tauri.conf.json`, and its Android
`WildflowerApplication` points `HeadlessBridge.nativeLibName` at the host's
library.

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

## References

- [Design Explanation](./docs/Design%20Explanation.md) — the flow, each
  decision, the wire, and what is not here.
- [wildflower-server AGENTS.md](../wildflower-server/AGENTS.md) — the server
  each run sets up and serves.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) and the
  [Wire Pinning How-To](../../docs/Messaging/Wire%20Pinning%20How-To.md) — the
  discipline `ServerServiceStatus` and `RestartServer` follow.
