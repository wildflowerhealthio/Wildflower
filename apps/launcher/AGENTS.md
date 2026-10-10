# AGENTS.md — apps/launcher

The **launcher**: the web app that manages a Wildflower server, published at
<https://wildflowerhealth.io/launcher/>, and the packages beside it that only
the launcher uses: the server-status wire and its screens, and the app
registry's client and screens. The app itself is
[`launcher-web`](./launcher-web/AGENTS.md).

## Packages

- [`apps-core-js`](./apps-core-js) and [`apps-react`](./apps-react) — the
  TypeScript half of the [`apps` slice](../../slices/apps/AGENTS.md), whose
  server half (`apps-rust`) stays in `slices/apps`. `apps-core-js` is the
  registry's `HttpApi` definition and clients, held to
  `slices/apps/apps-rust/openapi/apps.openapi.json` by its drift test;
  `apps-react` is the homescreen and the `/settings/apps` pages, which
  `launcher-web`'s `routes.config.ts` mounts.
- [`launcher-web`](./launcher-web/AGENTS.md) — the app. One source tree and two
  entries, each passing its platform's wiring to `buildAppTree`: `main-web`, the
  build published at `/launcher/`, cross-origin to the server `?server=` names,
  signing in by SMART redirect and holding its bearer in page memory; and
  `main-tauri`, the wiring for a webview the host authenticates, which no app
  mounts today (the Tauri host's webview mounts the servers base,
  `apps/host/servers/servers-react`, instead). Both boot only after the telemetry
  consent dialog is answered. It mounts the settings and route fragments of the
  slices it composes.
- [`wildflower-server-core-js`](./wildflower-server-core-js/AGENTS.md) — the
  pure layer of the server-status wire: `BackgroundServerServiceBridge`, the
  host's `ServerServiceStatus` snapshot of the Wildflower server it runs and the
  page's `RestartServer` request. The contract the Rust mirror in
  `slices/background-server-service/background-server-service-rust` is pinned
  to, byte for byte, by `bridge-wire-golden.json`.
- [`wildflower-server-react`](./wildflower-server-react/AGENTS.md) — the page
  side of that wire: the status store and the boot-stable handler that fills it,
  `ServerStatusBanner`, the `/settings/server` page and the `RestartServer`
  sender. `launcher-web` builds the store and, on `main-tauri` only, mounts the
  banner and links the page from Settings.

## Rules

- **The app composes; the packages beside it own the wire.** `launcher-web`
  imports `wildflower-server-core-js` and `wildflower-server-react`; neither
  imports the app. `wildflower-server-react` depends on
  `wildflower-server-core-js` and never the reverse.
- **A wire change edits three things together.** `bridge-wire-golden.json`
  (in `slices/background-server-service`), the TS schema in
  `wildflower-server-core-js` and the serde mirror in
  `background-server-service-rust`. See that slice's
  [AGENTS.md](../../slices/background-server-service/AGENTS.md).
- **The slice and the Rust crate keep their names.** The wire is still
  `BackgroundServerServiceBridge` and its Rust crate
  `background-server-service-rust`; only the TS packages moved here.

## References

- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows
- [slices/background-server-service/AGENTS.md](../../slices/background-server-service/AGENTS.md)
  — the wire's role, its Rust crate and golden file
- [Architecture / slice layering](../../slices/AGENTS.md)
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) — the webview ↔ host bridge the wire rides
