# AGENTS.md — apps/synthetic-data/synthetic-data-fhir-sync-pebble

The **FHIR Sync for Pebble generator**: a `Physiology` — what a wrist-worn
watch measures, day by day — as the Observations the FHIR Sync for Pebble
phone app writes when the watch syncs it. Every Observation is built by
`fhir-sync-pebble-core`'s own code (`HealthActivity.decodeMessage`,
`MinuteHistory`, `WatchSync.toObservations`), so it is exactly what the app
writes. No DOM, no `fs`, no React.

## Shape

The root entry exports `PebbleObservations`, `PebbleWatch` and the
`Physiology` types:
`import { PebbleObservations, PebbleWatch, type Physiology } from '@wildflowerhealthio/synthetic-data-fhir-sync-pebble'`.

- `src/physiology.ts` — `Physiology`, the generator's input and plain data a
  data set writes: the wearer's UTC offset (whole hours), a circadian
  heart-rate rhythm, and per `StoryDay` the resting heart rate, the night that
  ends that day (asleep, awake, wake-ups, restful blocks), walks (cadence and
  heart-rate rise) and time on the charger. Times are minutes from the day's
  local midnight.
- `src/minute-timeline.ts` — the minute-by-minute model: each worn local
  minute's heart rate (resting + rhythm + sleep stage + walk ramp, with a
  seeded ±2 bpm wobble), steps and movement (vmc); charging minutes are
  invalid. `sleepStretchesOf` splits a night at its wake-ups.
- `src/pebble-watch.ts` — `PebbleWatch.watchOf(keys)`: a deterministic watch
  (token hashed from the keys; model and firmware, a `WatchDevice.WatchInfo`,
  picked from the Pebble Time 2 builds the app targets), and `toReference`,
  the Observations' `device` as `WatchDevice.toReference` writes it.
- `src/pebble-observations.ts` — `PebbleObservations.render`, given the
  as-of date, the watch, the patient id and the physiology: the Sleep,
  RestfulSleep and Walk activities
  (decoded from the messages the watch would send, `HealthActivityType`) and
  every worn UTC hour's heart-rate, steps and vmc minute history, collected as
  one `WatchSync` and written by `WatchSync.toObservations`.

`synthetic-data-fhir-sync-pebble/test-helpers` (`src/test-helpers.ts`) holds
`physiologyCaseArbitrary`: a physiology over some days, its watch and patient,
and the sleep stretches it must render as.

## Layering

Depends on `synthetic-data-fundamentals` (`StoryDay` from `/story`, `Seeding`
from `/seeding`) and `fhir-sync-pebble-core` (its PebbleKit JS half:
`HealthActivity`, `MinuteHistory`, `WatchDevice`, `WatchSync`). The tests also
use `fhir-r4` to decode every Observation, as a dev dependency only. Never
imports a `-react`, `-node` or `-tauri` package.

## Rules

- **The app writes it, not this package.** Activities go through
  `HealthActivity.decodeMessage` as the watch's messages, and the whole
  physiology through `WatchSync.toObservations`; ids, codings, units and
  sample encoding are the core's.
- **The subject is a stored Patient id.** `patientId` is what the phone's
  settings name; to put the watch's data on the Patient a pharmacy import
  made, pass that Patient's stored id (the one in
  `rexallPatientReferenceOf` / `shoppersPatientReferenceOf`'s `reference`).
- **Values do not move with the as-of date.** Minutes are counted on the
  story's local clock, so the wobble and every value depend only on the
  physiology and the watch; moving the as-of date moves only the timestamps.

## Traps

- **Activities are not clipped to worn minutes.** A night that starts before
  its day's midnight sends its Sleep from then, even if the day before is not
  listed; a charge overlapping a night blanks those minutes, not the night's
  activities (see `Physiology`'s remarks).
- **The UTC offset is fixed,** so daylight saving time is not modelled.
- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `test-helpers`).

## References

- [apps/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [fhir-sync-pebble AGENTS.md](../../../apps/fhir-sync-pebble/AGENTS.md) — the app's
  core and what a sync writes.
