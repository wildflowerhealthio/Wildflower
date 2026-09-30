# AGENTS.md — slices/watch-lifts

**WatchLifts**: a Pebble watchapp for a barbell program. This slice holds what
its phone settings page edits, every person's weight at every exercise, and
what the watchapp's PebbleKit JS does with what the page saves; the watchapp
and its PebbleKit JS glue are [`apps/watch-lifts`](../../apps/watch-lifts/README.md).

## Packages

- `watch-lifts-core` — the pure layer, and currently the whole slice.
  Namespace modules, all re-exported from the package index. For the settings
  page: `LiftSettings` (the weights as an Effect Schema, whole pounds from 0
  to 999, a row per person and a weight per exercise; `toJson`, `fromJson` and
  `DEFAULT`). For the PebbleKit JS, also exported alone as
  `watch-lifts-core/pkjs`: `Lifts` (the exercises, the people and the default
  weights, mirroring the watch's `src/c/state.c`) and `PhoneSettings` (the
  page's `webviewclosed` response decoded, the weights kept in `localStorage`,
  the page's URL pre-filled with them, and the watch's `Weights` message). No
  DOM, no React, no platform imports.

Where the page may hand the weights back to (`ReturnTarget`) and the
`webviewclosed` response's decoding (`decodeWebviewResponse`, which
`PhoneSettings.decodeResponse` builds on) are
[`pebble-configuration`](../../global/pebble/pebble-configuration/README.md)'s,
generic over the settings.

## Rules

- **`LiftSettings.toJson` is external contract, both ways.** The PebbleKit JS
  opens the page with it in the `weights` query parameter
  (`PhoneSettings.configurationUrl`), and the page hands the same shape back,
  which `PhoneSettings.decodeResponse` parses. `LiftSettings.Schema` is pinned
  to `PhoneSettings.Settings`, so a field changed on one and not the other
  fails to compile, and `phone-settings.test.ts` round-trips generated weights
  through both.
- **`Lifts` mirrors the watch.** The exercises, people and default weights are
  `state.c`'s, in its order; the app's `test/state.test.ts` checks them against
  it. Changing one side alone labels or places every weight wrongly.
- **The wire layout is shared with the watch's C.** `PhoneSettings.toWatchMessage`
  writes 20 bytes, uint16 little-endian, person-major, which
  `weights_wire_decode` (`apps/watch-lifts/src/c/weights-wire.c`) reads; the
  app's `test/weights-wire.test.ts` round-trips one through the other.
- **The `pkjs` entry runs on ES5.** The phone's PebbleKit JS runtime is ES5,
  so nothing reachable from `src/pkjs.ts` may import Effect or any other
  module needing ES2015, or call an ES2015 method; its modules import nothing
  from the rest of the package, not even types, and decode with hand-written
  checks in place of Schemas. The watchapp's build type-checks them against
  ES5's library and fails on a violation.

## References

- [Architecture / slice layering](../AGENTS.md)
- [apps/watch-lifts README](../../apps/watch-lifts/README.md) — the watchapp, the settings hand-off and the wire
- [slices/fhir-sync-pebble](../fhir-sync-pebble/AGENTS.md) — the same pattern, with a SMART sign-in
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md)
