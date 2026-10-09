# AGENTS.md — apps/fhir-sync-pebble

**FHIR Sync for Pebble**: a Pebble watchapp that syncs the steps, sleep and
heart rate the Pebble records to a FHIR server. The watchapp itself, C for the
watch and PebbleKit JS for the phone, is
[`fhir-sync-pebble-watchapp`](./fhir-sync-pebble-watchapp/AGENTS.md); its
settings page is [`fhir-sync-pebble-web`](./fhir-sync-pebble-web/AGENTS.md).
The package beside them, `fhir-sync-pebble-core-js`, holds what the settings
page decides and what the PebbleKit JS does with the watch's data.

## Packages

- `fhir-sync-pebble-watchapp` — the Pebble app: its `package.json` is the
  Pebble manifest, with the PebbleKit JS build in `pkjs/`
  (`fhir-sync-pebble-pkjs`) and the host-side C tests in `test/`
  (`fhir-sync-pebble-test`).
- `fhir-sync-pebble-web` — the settings page, published at
  `/fhir-sync-pebble` on the GitHub Pages site.
- `fhir-sync-pebble-core-js` — the pure layer.
  Namespace modules, all re-exported from the package index. For the settings
  page: `PatientSummary` (a patient the settings page lists, read leniently
  out of a `Patient` search) and `PebbleSettings` (the watch's wire shape,
  built from the SMART grant and the picked patient). For the PebbleKit JS, also
  exported alone as `fhir-sync-pebble-core-js/pkjs`: `PhoneSettings` (the
  settings decoded on the phone, and the watch's part), `HealthActivity` and
  `MinuteHistory` (the watch's activity and hour messages decoded, and the
  Observations each becomes; `HealthActivityType` names pebble.h's activity
  values), `WatchDevice` (the watch as the Observations' `device`, from a
  `WatchInfo`, and the deterministic id each Observation is PUT under), and
  `WatchSync` (the phone's side of a sync as a pure reducer, `receive`: each
  message folded into the sync under way from its `SyncStart`, checked against
  the watch's counts, and what to do next; then `planWrite`, which checks the
  watch's connection against the settings and builds the transaction Bundle of
  PUTs; and the answer to the watch). No DOM, no React, no platform imports.

Where the page may hand the settings back to (`ReturnTarget`), how that
survives the SMART login (`ReturnTargetStore`) and the `webviewclosed`
response's decoding (`decodeWebviewResponse`, which
`PhoneSettings.decodeResponse` builds on) are
[`pebble-configuration`](../../global/pebble/pebble-configuration/README.md)'s,
generic over the settings.

## Rules

- **The core owns every FHIR decision the hand-off makes.** Which patients are
  listed and what the watch receives are pure functions here, so they are
  property-tested without a DOM.
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
- **`pebble-configuration`'s `ReturnTarget` is a security boundary here.** The
  settings carry a live access token, so a `return_to` off its allow-list would
  let a crafted link collect a token for the user's record.
- **`PatientSummary` is deliberately lenient.** It is not `fhir-r4`'s
  `Patient.Schema`: that refuses legal FHIR like a partial `birthDate`, and the
  page lists whatever server the user signed in to. Each search entry decodes
  on its own, and one that does not read as a patient with an id is dropped,
  not fatal; so does each name within it, with `given`'s `null` placeholders
  dropped. Its names are shaped for `fhir-r4`'s `HumanName.displayName`,
  which names the patient on the page and on the watch alike.

## References

- [Architecture / slice layering](../../slices/AGENTS.md)
- [fhir-sync-pebble-web AGENTS.md](./fhir-sync-pebble-web/AGENTS.md) — the settings page, the handoff steps, and the scopes
- [fhir-sync-pebble-watchapp AGENTS.md](./fhir-sync-pebble-watchapp/AGENTS.md) — the watchapp, the sync's messages, and the ES5 bundle
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md)
