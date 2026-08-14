# Learnings Inbox

A running log of non-obvious insights discovered during agent sessions. Triage into `Strategies` or a specific reference doc periodically.

_Last triaged 2026-07-04 — durable lessons were promoted to `Strategies.md`, testing- and Effect-tagged entries moved to `docs/Testing` / `docs/Effect`, and entries about removed code (Expo/React Native, Jest, the interop slice) were dropped. Git history preserves everything removed._

<!-- Append new entries below this line -->

## Scalar's browser defaults reach third parties unless turned off

`@scalar/api-reference` in its `web` layout (what `createApiReference` gives you) defaults `proxyUrl` to `https://proxy.scalar.com` — every "send" against a non-local target is routed through Scalar's hosted proxy, bearer token included — and `withDefaultFonts: true` pulls webfonts from `fonts.scalar.com`. Vendoring the npm package instead of the CDN script does not change either. `apps/wildflower-server-docs` sets `proxyUrl: ''` and `withDefaultFonts: false` and asserts both in `configuration.test.ts`; copy that if another page ever embeds Scalar.

## A default JSON import inlines the whole file, named imports tree-shake

`import config from './tauri-shared-config.json'` bakes the entire document — every unrelated field and comment — into the bundle even when one field is read. `import { loopback_hostname, loopback_port } from …` lets rolldown drop the rest. Worth doing whenever a shared config file is imported into a page that ships publicly.

## Renaming a diesel-seeded row id means deleting its child payload first

`self_hosted_app_configurations.id` (and every per-kind apps payload table) is a
FK onto `app_registrations(id)` with `ON DELETE CASCADE` and **no `ON UPDATE`
action**, and every pooled connection runs with `PRAGMA foreign_keys = ON`. So an
`UPDATE app_registrations SET id = …` while a payload row still references the old
id fails the constraint — and a failed migration aborts `SqliteAppsStore::open`,
taking the whole registry down. Order the statements payload-delete → registration
rename → new payload insert (see apps migration `0005_first_party_apps_to_cloud`).

## A dev-only seeded row cannot be a migration — but it must run before `setup_apps`

Migrations are embedded, run unconditionally, and are tracked by version, so
anything a migration writes exists in release databases too. Debug-only rows
therefore have to be a runtime seed behind `#[cfg(debug_assertions)]` (module-level
gating, not just the call site, or a release build still compiles the code). The
non-obvious constraint: `setup_apps` materializes the self-hosted catalogue once
and the host binds one loopback listener per row from that snapshot, so a dev seed
that runs _after_ it gets no listener. Seeding on its own `SqliteAppsStore` before
`setup_apps` is what makes the rows both migrated and bound.

## A self-hosted app's OAuth `client_id` must equal its app id; a cloud app's must not rely on it

The host's `SelfHostedRedirectResolver` resolves an app-relative redirect URI
(`"/"`) by looking the app up **by `client_id`** and requiring the row to be
self-hosted. Flipping an app to `kind = cloud` therefore silently breaks its
app-relative redirect — it resolves to nothing and matches no request (fail-closed,
so it looks like a rejected `redirect_uri` rather than a config error). A cloud app
needs an absolute redirect URI registered instead.
