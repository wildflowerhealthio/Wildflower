# AGENTS.md — apps/launcher

The **launcher**: the web app that manages a Wildflower server, published at
<https://wildflowerhealth.io/launcher/>, and the packages beside it that only
the launcher uses: the TypeScript halves of the server features it manages
(collectors, the HAR Recorder, databases, the request log, the app registry),
the server-status wire and its screens, and the host navigation reporter. The
app itself is [`launcher-web`](./launcher-web/AGENTS.md).

Where a feature also has a server half, its Rust crate lives with the server
the host runs, in
[`apps/host/wildflower-server/`](../host/wildflower-server/AGENTS.md).

## Packages

- [`launcher-web`](./launcher-web/AGENTS.md) — the app. One source tree and two
  entries, each passing its platform's wiring to `buildAppTree`: `main-web`, the
  build published at `/launcher/`, cross-origin to the server `?server=` names,
  signing in by SMART redirect and holding its bearer in page memory; and
  `main-tauri`, the wiring for a webview the host authenticates, which no app
  mounts today (the Tauri host's webview mounts the servers base,
  `apps/host/servers/servers-react`, instead). Both boot only after the telemetry
  consent dialog is answered. It mounts the settings and route fragments of the
  packages it composes (`routes.config.ts`).
- [`apps-core-js`](./apps-core-js) and [`apps-react`](./apps-react) — the
  TypeScript half of the app registry, whose server half is
  [`apps-rust`](../host/wildflower-server/apps-rust/AGENTS.md). `apps-core-js` is the
  registry's `HttpApi` definition and clients, held to
  `apps/host/wildflower-server/apps-rust/openapi/apps.openapi.json` by its drift test;
  `apps-react` is the homescreen and the `/settings/apps` pages.
- [`collector/`](./collector/AGENTS.md) — the collectors: the vocabulary and
  handler machines (`collector-fundamentals`), the closed registry and remotes
  `HttpApi` (`collector-registry`), one `*-client-collector` per import site,
  `web-trace-source`, and the screens and sync runner (`collector-react`).
- [`har-recorder/`](./har-recorder/AGENTS.md) — the HAR Recorder:
  `har-recorder-core-js` and the `/har-recorder` page in `har-recorder-react`.
- `databases/` — `databases-core-js`, the `/databases` `HttpApi` and client,
  and `databases-react`, the `/settings/databases` screen.
- `request-log/` — `request-log-core-js`, the `/requests` `HttpApi` and client,
  and `request-log-react`, the `/settings/requests` activity page.
- [`navigation-react`](./navigation-react) — the bridge handler that reports
  route changes to the host. Its wire, `navigation-core`, stays in
  `slices/navigation-core`, because `fhir-r4` reads it too.
- [`wildflower-server-core-js`](./wildflower-server-core-js/AGENTS.md) — the
  pure layer of the server-status wire: `BackgroundServerServiceBridge`, the
  host's `ServerServiceStatus` snapshot of the Wildflower server it runs and the
  page's `RestartServer` request, pinned by `test/bridge-wire-golden.json`.
- [`wildflower-server-react`](./wildflower-server-react/AGENTS.md) — the page
  side of that wire: the status store and the boot-stable handler that fills it,
  `ServerStatusBanner`, the `/settings/server` page and the `RestartServer`
  sender. `launcher-web` builds the store and, on `main-tauri` only, mounts the
  banner and links the page from Settings.

## Rules

- **The app composes; the packages beside it own the features.** `launcher-web`
  imports the packages here; none of them imports the app. Within a group a
  `-react` package depends on its `-core-js`, never the reverse.
- **A group is the slice it came from.** Packages that came from one slice sit
  in a folder named for it (`collector/`, `har-recorder/`, `databases/`,
  `request-log/`), carrying that slice's AGENTS.md and docs; a lone package sits
  directly here.
- **A server-wire change edits both folders.** The OpenAPI snapshot each
  `-core-js` (and `collector-registry`) drift test reads is committed beside
  its Rust crate in `apps/host/wildflower-server/`; see that folder's
  AGENTS.md for regenerating one.

## References

- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows
- [apps/host/wildflower-server/AGENTS.md](../host/wildflower-server/AGENTS.md)
  — the Rust halves of the features here
- [Architecture / slice layering](../../slices/AGENTS.md)
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) — the webview ↔ host bridge the wires ride
