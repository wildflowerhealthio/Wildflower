# AGENTS.md — apps/launcher

The **launcher**: the web app that manages a Wildflower server, published at
<https://launcher.wildflowerhealth.io/>, and the packages beside it that only
the launcher uses: the TypeScript halves of the server features it manages
(databases, the request log, the app registry). The app itself is
[`launcher-web`](./launcher-web/AGENTS.md).

Where a feature also has a server half, its Rust crate lives with the server
the host runs, in
[`apps/host/wildflower-server/`](../host/wildflower-server/AGENTS.md).

## Packages

- [`launcher-web`](./launcher-web/AGENTS.md) — the app, published at
  <https://launcher.wildflowerhealth.io/>: cross-origin to the server it signs in to, signing in by SMART
  redirect and holding its session (the server and its bearer) for every
  request. It boots only after the telemetry consent dialog is answered, and
  mounts the settings and route fragments of the packages it composes
  (`routes.config.ts`).
- [`apps-core-js`](./apps-core-js) and [`apps-react`](./apps-react) — the
  TypeScript half of the app registry, whose server half is
  [`apps-rust`](../host/wildflower-server/apps-rust/AGENTS.md). `apps-core-js` is the
  registry's `HttpApi` definition and clients, held to
  `apps/host/wildflower-server/apps-rust/openapi/apps.openapi.json` by its drift test;
  `apps-react` is the homescreen and the `/settings/apps` pages.
- `databases/` — `databases-core-js`, the `/databases` `HttpApi` and client,
  and `databases-react`, the `/settings/databases` screen.
- `request-log/` — `request-log-core-js`, the `/requests` `HttpApi` and client,
  and `request-log-react`, the `/settings/requests` activity page.

## Rules

- **The app composes; the packages beside it own the features.** `launcher-web`
  imports the packages here; none of them imports the app. Within a group a
  `-react` package depends on its `-core-js`, never the reverse.
- **A group is the slice it came from.** Packages that came from one slice sit
  in a folder named for it (`databases/`, `request-log/`), carrying that slice's AGENTS.md and docs; a lone package sits
  directly here.
- **A server-wire change edits both folders.** The OpenAPI snapshot each
  `-core-js` drift test reads is committed beside
  its Rust crate in `apps/host/wildflower-server/`; see that folder's
  AGENTS.md for regenerating one.

## References

- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows
- [apps/host/wildflower-server/AGENTS.md](../host/wildflower-server/AGENTS.md)
  — the Rust halves of the features here
- [Architecture / slice layering](../../slices/AGENTS.md)
