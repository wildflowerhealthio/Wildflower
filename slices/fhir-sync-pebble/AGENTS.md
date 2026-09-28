# AGENTS.md — slices/fhir-sync-pebble

**FHIR Sync for Pebble**: a Pebble watchapp that syncs the steps, sleep and
heart rate the Pebble records to a FHIR server. This slice holds what its
settings page decides and what the watchapp's PebbleKit JS does with the
watch's data; the page itself is
[`apps/fhir-sync-pebble-web`](../../apps/fhir-sync-pebble-web/AGENTS.md), and
the PebbleKit JS glue is [`apps/fhir-sync-pebble`](../../apps/fhir-sync-pebble/AGENTS.md)'s
`pkjs/`.

## Packages

- `fhir-sync-pebble-core` — the pure layer, and currently the whole slice.
  Namespace modules, all re-exported from the package index. For the settings
  page: `PatientSummary` (a patient the settings page lists, read leniently
  out of a `Patient` search), `PebbleSettings` (the watch's wire shape, built
  from the SMART grant and the picked patient), `ReturnTarget` (the
  allow-listed Pebble `return_to` and the hand-off URL), and
  `ReturnTargetStore` (keeps `return_to` across the SMART login over a Web
  Storage–shaped store the app passes in). For the PebbleKit JS, also
  exported alone as `fhir-sync-pebble-core/pkjs`: `PhoneSettings` (the
  settings decoded on the phone, and the watch's part), `HealthActivity` and
  `MinuteHistory` (the watch's activity and hour messages decoded, and the
  Observations each becomes), `WatchDevice` (the watch as the Observations'
  `device`, and the deterministic id each Observation is PUT under), and
  `WatchSync` (the phone's side of a sync as a pure reducer, `receive`: each
  message folded into the sync under way from its `SyncStart`, checked against
  the watch's counts, and what to do next; then `planWrite`, which checks the
  watch's connection against the settings and builds the transaction Bundle of
  PUTs; and the answer to the watch). No DOM, no React, no platform imports.

## Rules

- **The core owns every decision the hand-off makes.** Which patients are
  listed, what the watch receives, where it may be sent, and what survives the
  login are pure functions here, so they are property-tested without a DOM.
  The app reads the handshake and the patients, and renders what this package
  returns.
- **A sync's writes are idempotent.** Every Observation's id derives from the
  watch token, the patient and what identifies the record
  (`WatchDevice.observationId`), and the Bundle PUTs each to it, so sending a
  record again replaces it. The derivation is `fhir-r4`'s `localResourceId`,
  ported without `bigint` for ES5 (`local-resource-id.ts`) and held to the
  original by a parity test; changing either changes every id, and the next
  sync duplicates everything already synced.
- **`PebbleSettings.toJson` is external contract.** It is what the watchapp's
  `webviewclosed` handler parses with `PhoneSettings.decodeResponse`.
  `PebbleSettings.Schema` is pinned to `PhoneSettings.Settings`, so a field
  changed on one and not the other fails to compile.
- **The `pkjs` entry runs on ES5.** The phone's PebbleKit JS runtime is ES5,
  so nothing reachable from `src/pkjs.ts` may import Effect, `fhir-r4` or any
  other module needing ES2015, or call an ES2015 method; its modules import
  nothing from the rest of the package, not even types, and decode with
  hand-written checks in place of Schemas. The watchapp's build
  type-checks them against ES5's library and fails on a violation.
- **`ReturnTarget` is a security boundary.** The settings carry a live access
  token, so only the Pebble phone app's `pebblejs:` scheme and loopback
  `http(s)` (the `pebble` tool's emulator) decode. Widening the allow-list lets
  a crafted link collect a token for the user's record.
- **`PatientSummary` is deliberately lenient.** It is not `fhir-r4`'s
  `Patient.Schema`: that refuses legal FHIR like a partial `birthDate`, and the
  page lists whatever server the user signed in to. Each search entry decodes
  on its own, and one that does not read as a patient with an id is dropped,
  not fatal; so does each name within it, with `given`'s `null` placeholders
  dropped. Its names are shaped for `fhir-r4`'s `HumanName.displayName`,
  which names the patient on the page and on the watch alike.
- **Storage is a parameter.** `ReturnTargetStore.fromWebStorage` takes a
  structural `WebStorage`, the way `gatekeeper-core`'s sign-in takes its
  `PendingStore`, so the core names no DOM type and the app is the one place
  `sessionStorage` appears.

## References

- [Architecture / slice layering](../AGENTS.md)
- [apps/fhir-sync-pebble-web AGENTS.md](../../apps/fhir-sync-pebble-web/AGENTS.md) — the settings page, the handoff steps, and the scopes
- [apps/fhir-sync-pebble AGENTS.md](../../apps/fhir-sync-pebble/AGENTS.md) — the watchapp, the sync's messages, and the ES5 bundle
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md)
