# AGENTS.md — apps/host

The **host**: the Tauri app ("Wildflower Host", `io.wildflowerhealth.hostapp`)
that runs this install's Wildflower servers on the device and ships to the app
stores, and the packages beside it that only the host uses. The app itself is
[`host-app`](./host-app/README.md).

## Packages

- [`host-app`](./host-app/README.md) — the app: the Vite entry its webview
  loads and, in `src-tauri`, the `host-app` crate (`host_app_lib`) that builds
  the Tauri app, registers the plugins and commands, and hosts the servers. The
  committed `src-tauri/gen/` holds its Xcode and Gradle projects.
- [`servers/`](./servers/AGENTS.md) — the servers this install knows about, how
  the host runs them, and the **base**, the UI the host's webview mounts:
  `servers-core-js`, `servers-react`, `servers-rust`, `servers-tauri-rust`,
  their docs and `servers-wire-golden.json`.
- [`unit-runner/`](./unit-runner/unit-runner-rust/AGENTS.md) — the
  platform-neutral `unit-runner-rust`, which runs units under run policies, and
  [`tauri-unit-runner-rust`](./unit-runner/tauri-unit-runner-rust/AGENTS.md),
  its Tauri binding over `tauri-plugin-background-service`.
- [`wildflower-server-rust`](./wildflower-server-rust/AGENTS.md) — the
  Wildflower server the host runs: it composes the server slices' Rust crates
  (gatekeeper, emr, OHIF, collector, request log, apps, databases) into one API.
- [`shared-structures-tauri-rust`](./shared-structures-tauri-rust) — the host's
  Tauri glue for `shared-structures-rust`, such as `resolve_http_url`.
- [`tauri-plugin-native-webview`](./tauri-plugin-native-webview/docs/Explanation.md)
  — the native, JS-injectable web view plugin (iOS, Android, desktop).

## Rules

- **Only the host uses these.** A package lives here because the host is its
  only consumer. Anything a second product needs moves back to `slices/` or
  `global/` ([What folds in](../AGENTS.md#what-folds-in)).
- **One exception reads across.** `slices/browser-sniffer/browser-sniffer-tauri-rust`
  depends on `tauri-plugin-native-webview`; the plugin lives here with its only
  app.
- **Slice layering still applies inside a group.** `servers-react` imports
  `servers-core-js`, never the reverse; `servers-tauri-rust` composes
  `servers-rust`; `tauri-unit-runner-rust` binds `unit-runner-rust`.

## References

- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows
- [Architecture / slice layering](../../slices/AGENTS.md)
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) — the webview ↔ host bridge
