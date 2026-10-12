# AGENTS.md — apps/host

The **host**: the Tauri app ("Wildflower Host", `io.wildflowerhealth.hostapp`)
that runs this install's Wildflower servers on the device and ships to the app
stores, and the packages beside it that only the host uses. The app itself is
[`host-app`](./host-app/README.md).

## Packages

- [`host-app`](./host-app/README.md) — the app: the Vite entry its webview
  loads, which owns the one TanStack router, behind the base's telemetry
  consent gate (`servers-react`'s `BaseGate`). Its `routes.config.ts` composes
  its root layout, a bar of two TanStack `<Link>`s over every route, **Servers**
  (the base's screens, `servers-react`'s `routes/_servers/` mounted under a
  pathless `_servers` layout, `BaseLayout`) and **Recorder** (`/recorder`,
  `recorder-react`'s `RecorderPage`, over an `effect-messaging-tauri-js`
  transport for `RecorderBridge`, whose `RecorderProvider` the layout holds
  so a recording outlives the route), with a Page not found under the bar for
  any other path; and, in `src-tauri`, the `host-app` crate (`host_app_lib`) that builds
  the Tauri app, registers the plugins and commands, and hosts the servers. The
  committed `src-tauri/gen/` holds its Xcode and Gradle projects.
- [`servers/`](./servers/AGENTS.md) — the servers this install knows about, how
  the host runs them, and the **base**, the UI of the host's Servers tab:
  `servers-core-js`, `servers-react`, `servers-rust`, `servers-tauri`,
  their docs and `servers-wire-golden.json`.
- [`recorder/`](./recorder/AGENTS.md) — the **Recorder**, which records a
  page's fetch/XHR responses in the sniffer webview and saves them as a HAR
  file, behind the host's Recorder tab: `recorder-core-js`,
  `recorder-react`, `recorder-rust`, `recorder-tauri`, their docs and
  `recorder-wire-golden.json`.
- [`unit-runner/`](./unit-runner/unit-runner-rust/AGENTS.md) — the
  platform-neutral `unit-runner-rust`, which runs units under run policies, and
  [`tauri-unit-runner-rust`](./unit-runner/tauri-unit-runner-rust/AGENTS.md),
  its Tauri binding over `tauri-plugin-background-service`.
- [`wildflower-server/`](./wildflower-server/AGENTS.md) — the Wildflower
  server the host runs,
  [`wildflower-server-rust`](./wildflower-server/wildflower-server-rust/AGENTS.md),
  which composes the server features' Rust crates (gatekeeper, FHIR R4, OHIF,
  request log, apps, databases, tunnel) into one API; beside it the
  crates only the host composes: `gatekeeper-rust`, `token-revocation-rust`,
  `fhir-r4-rust`, `apps-rust`, `tunnel-rust`, `databases-rust` and
  `request-log-rust`.
- [`shared-structures-tauri`](./shared-structures-tauri) — the host's
  Tauri glue for `shared-structures-rust`, such as `resolve_http_url`.
- [`tauri-plugin-native-webview`](./tauri-plugin-native-webview/docs/Explanation.md)
  — the native, JS-injectable web view plugin (iOS, Android, desktop).
- [`browser-sniffer-tauri`](./browser-sniffer-tauri) — the browser
  sniffer's Tauri host adapter, which opens the sniffer in that plugin's web
  view and embeds the bootstrap that `slices/browser-sniffer`'s
  `browser-sniffer-tauri-js` builds. The slice keeps its TypeScript packages and
  docs: [Tauri Host Explanation](../../slices/browser-sniffer/docs/Tauri%20Host%20Explanation.md).

## Rules

- **Only the host uses these.** A package lives here because the host is its
  only consumer; a crate in `wildflower-server/`, because the host is its only
  Rust consumer, its TypeScript half living with the launcher or in a shared slice. Anything a
  second product needs moves back to `slices/` or `global/`
  ([What folds in](../AGENTS.md#what-folds-in)).
- **Slice layering still applies inside a group.** `servers-react` imports
  `servers-core-js`, never the reverse; `servers-tauri` composes
  `servers-rust`; `tauri-unit-runner-rust` binds `unit-runner-rust`.
- **Groups don't import each other.** `servers-react` knows nothing of the
  recorder, nor `recorder-react` of the servers; `host-app` composes both.
- **One router, the app's.** As `launcher-web` composes the launcher's
  packages, `host-app` mounts a package's route bucket with `physical()` under
  a layout of the bucket's name, so both route generators compute the same
  ids, and only `host-app` declares `Register`. A package keeps a
  package-local router in `router.ts`, never exported, for its own type checks
  and tests.

## References

- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows
- [Architecture / slice layering](../../slices/AGENTS.md)
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) — the webview ↔ host bridge
