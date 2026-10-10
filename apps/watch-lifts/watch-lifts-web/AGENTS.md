# AGENTS.md — apps/watch-lifts/watch-lifts-web

The settings page of the [WatchLifts](../watch-lifts-watchapp/README.md) Pebble
watchapp: a table of every person's weight at every exercise, and a save that
sends them to the watch. It is served from the published GitHub Pages site
(`/watch-lifts`). The Pebble phone app opens it; there is no sign-in.

`apps/fhir-sync-pebble/fhir-sync-pebble-web` is the template for the shape (a relative `base`,
one `index.html` entry, a build into the package's own `dist/`). What differs:
no SMART, no router, no TanStack Query, and no `ReturnTargetStore`, because
nothing navigates away before the save.

## Layout

- `main.tsx` — restores a GitHub Pages 404 redirect, reads the page's inputs
  from its URL (`page-url.ts`) and mounts the page.
- `page-url.ts` — `readPageUrl`: the weights in the `weights` query parameter
  (`LiftSettings.fromJson`), else `LiftSettings.DEFAULT`, and `return_to` as a
  `ReturnTarget` (`pebble-configuration`), else the guide's `pebblejs://close#`.
- `weights-page.tsx` — the page: the table, one row per exercise and one column
  per person, each cell a text input labelled with its person and exercise;
  or, for a foreign `return_to`, a refusal banner and no save.
- The decisions live in [`watch-lifts-core-js`](../AGENTS.md)
  (`Lifts`, the exercises, people and maximum weight; `LiftSettings`, the
  weights' Schema and JSON) and
  [`pebble-configuration`](../../../global/pebble/pebble-configuration/README.md)
  (`ReturnTarget`).

The npm package is `watch-lifts-web`, and the published path segment is
`watch-lifts` (`SECTION_PATHS.watchLifts`). It is not a SMART app, so it has no
nav link, no app description, no OAuth client and no homescreen tile.

## The Pebble configuration handoff

1. The watchapp's PebbleKit JS opens the page with the current weights as
   `?weights=<JSON>` (`PhoneSettings.configurationUrl`), and the phone app
   adds `return_to`.
2. Save checks the whole table against `LiftSettings.Schema` and navigates to
   `ReturnTarget.handoffUrl(returnTarget, LiftSettings.toJson(weights))`.

## Traps

- **`return_to` is allow-listed.** Only the `pebblejs:` scheme and loopback
  `http(s)` (the `pebble` tool's emulator configuration server) decode as a
  `ReturnTarget`. Anything else shows a refusal and offers no save.
- **A cell is text until Save.** The inputs are `type="text"` with
  `inputMode="numeric"`, so a half-typed value is never rewritten. Save reads
  only digits as a number; anything else, a decimal included, fails the Schema,
  and the banner names every failing cell.
- **A bad `?weights=` falls back to the defaults** without a message: the
  PebbleKit JS only ever writes valid settings.

## Development

`vp run -F @wildflowerhealthio/watch-lifts-web dev` serves on the port
`dev-app-ports.json` pins for `watch-lifts-dev` (5197). Append
`?return_to=http://localhost:<port>/` to try the handoff without a phone. For
`pebble emu-app-config` against it, point `CONFIGURATION_URL` in
`apps/watch-lifts/watch-lifts-watchapp/pkjs/src/index.ts` at the dev server.

`vp test` for this package needs the workspace-local binary
(`node_modules/.bin/vp`) — the global `vp`'s bundled vitest cannot resolve
jsdom.

## References

- [apps/watch-lifts/watch-lifts-watchapp README](../watch-lifts-watchapp/README.md) — the watchapp and the
  settings hand-off
- [apps/watch-lifts AGENTS.md](../AGENTS.md) — the umbrella, and the core
- [apps/fhir-sync-pebble/fhir-sync-pebble-web AGENTS.md](../../fhir-sync-pebble/fhir-sync-pebble-web/AGENTS.md) —
  the template app
- [apps/wildflower-site/wildflower-site-web README](../../wildflower-site/wildflower-site-web/README.md) — how the site is
  assembled
