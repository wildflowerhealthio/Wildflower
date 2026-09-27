# AGENTS.md — apps/fhir-sync-pebble

FHIR Sync for Pebble, the watchapp: a C app for the watch and PebbleKit JS for
the phone. Its settings page is [`apps/fhir-sync-pebble-web`](../fhir-sync-pebble-web/AGENTS.md),
where the user signs in to a FHIR server and confirms the patient. Sync Now
sends every checked data type: Health Activity from HealthService's
activities, the other five from its minute history.

`apps/watch-lifts` is the template for the shape: this `package.json` is the
Pebble manifest, and host-side tests live in a separate `test/` package.

## Building and running

```sh
pebble build                          # build for targetPlatforms (emery only)
pebble install --emulator emery       # install on the emery emulator
pebble emu-app-config --emulator emery  # open the settings page for the emulator
pebble install --phone <ip>           # install to a paired phone
```

The Pebble SDK and the `pebble` tool are needed only for these; the tests use
the host `cc`.

## Layout

- `src/pkjs/index.js` — opens `https://wildflowerhealth.io/fhir-sync-pebble/` on
  `showConfiguration`, and on `webviewclosed` decodes the response, keeps the
  full settings in `localStorage` and sends the watch its part. On
  `appmessage` it collects a sync's activities and hours and posts them to the
  server.
- `src/pkjs/settings.js` — the decodes (`decodeResponse`, and `decodeStored`
  for what `localStorage` holds) and the watch's message (`toWatchMessage`),
  free of Pebble globals so tests load it under Node; `settings.d.ts` types it
  for them.
- `src/pkjs/health-activity.js` — the same for the sync: decodes the watch's
  activity messages and builds the Observations and their transaction Bundle;
  `health-activity.d.ts` types it.
- `src/pkjs/minute-history.js` — the same for the hours of minute history:
  decodes each hour message and builds its SampledData Observations;
  `minute-history.d.ts` types it.
- `src/c/fhir-sync-pebble.c` — `main` and the AppMessage callbacks. `main`
  owns the one `App` (the `AppState`, the settings window and the `Sync`) on
  its stack and passes it as the AppMessage context. The one file-scope static
  is the `.bss` anchor (see Traps).
- `src/c/sync.c` — `Sync`, one Sync Now run: collects the activities from
  HealthService, sends them and then each hour of minute history to the phone
  one message at a time, and ends the sync on the phone's answer, a failed
  send or a timeout.
- `src/c/minute-wire.c` — packs one minute of `HealthMinuteData` into the
  bytes an hour message carries, kept buildable on the host.
- `src/c/state.c` — `AppState`, the state behind the menu, and its persist
  storage. Readers read its fields; changes go through the `state_*`
  functions, which persist them.
- `src/c/windows/settings-window.c` — the app's one window, hosting the
  settings menu.
- `src/c/views/settings-menu-layer.c` — the `MenuLayer`, with itself as its
  callback context: row order, dispatch, the checkbox toggle and the Sync Now
  handler `main` passes down through the window. Each row
  kind draws itself from `views/settings-menu-layer/`: `status-row` (last sync,
  last sign-in), `patient-row` (name, birth date), `data-type-row` (a checkbox
  per `DataType`) and `sync-now-row`.
- `src/c/menu-text.c` — every row's text, kept buildable on the host.

## What reaches the watch

The settings carry a live access token, so only what the watch shows crosses
over AppMessage: `PatientName`, `PatientBirthDate` (each `""` when the record
has none — AppMessage has no null) and `AuthTime`, the Unix seconds at which the
phone received the settings. The token and FHIR base URL stay in PebbleKit JS's
`localStorage`, where the sync reads them.

`decodeResponse` must accept exactly what the settings page's
`PebbleSettings.toJson` writes; `test/settings.test.ts` round-trips generated
settings through both to hold the two together.

## Health Activity sync

Sync Now, with Health Activity checked, iterates `health_service_activities_iterate`
from Health Activity's last sync to now and keeps each activity that ended
after the last sync (an activity under way at one sync is sent again, longer,
at the next). The messages, all `int32`:

- watch → phone, one per activity: `ActivityType` (pebble.h's `HealthActivity`
  value, one bit each), `ActivityStart`, `ActivityEnd` (Unix seconds);
- watch → phone, then: one message per hour of minute history (next section);
- watch → phone, last: `ActivityCount` and `MinuteHourCount`, how many of each
  preceded it;
- phone → watch: `SyncSucceeded`, 1 when the server stored them all.

The phone posts one transaction Bundle of every Observation (see
`health-activity.js` for the activity coding, from the HealthService docs page)
to the FHIR base URL with the stored token. It answers 0 if either count doesn't
match what arrived, any message fails to decode, the settings are missing or the
request fails. With nothing to post it answers 1 without a request. There is no
server-side dedup, so an activity under way at one sync lands twice.

## Minute history sync

The other five data types come from `health_service_get_minute_history`, whole
UTC clock hours at a time. A sync covers from the oldest last-sync time among
the checked minute types (on a type's first sync, the oldest minute the watch
holds) up to the start of the hour the sync began in, which becomes those
types' last-sync time. An hour is never sent twice. Each hour with a valid
minute and a type still due is one message:

- `MinuteHourStart`: Unix seconds, on the hour;
- `MinuteTypes`: the types to post for that hour, one bit per `DataType`
  (Heart Rate = bit 1 … Ambient Light = bit 5), so a type checked later starts
  from its own last sync. The types are the ones checked when the sync began
  (those with a `synced_through`), so toggling a checkbox mid-sync takes effect
  at the next sync rather than skipping hours the success would mark synced;
- `MinuteData`: 60 minutes × 6 bytes, laid out in `minute-wire.h`.

The phone turns each type into one Observation per hour whose value is
`valueSampledData`: origin 0, period 60 000 ms, one sample per minute, `E` for
an invalid minute or one without a reading. A type with no sample that hour gets
no Observation. The conversions come from the Core Devices PebbleOS sources:

| Type          | Code                           | Unit           | Conversion                                                        |
| ------------- | ------------------------------ | -------------- | ----------------------------------------------------------------- |
| Heart Rate    | LOINC `8867-4`                 | `/min`         | as is; 0 bpm is "no reading"                                      |
| Steps         | LOINC `55423-8`                | `{steps}`      | as is                                                             |
| Movement      | `HealthMinuteData.vmc`         | `{counts}/min` | as is: ActiGraph-scaled vector magnitude counts                   |
| Orientation   | `HealthMinuteData.orientation` | `deg`          | yaw and pitch components, SampledData `factor` 22.5 over the bins |
| Ambient Light | `HealthMinuteData.light`       | `lx`           | the level's band midpoint: 650, 750, 850 or 950                   |

The Pebble codes use the HealthService docs page as their system.

- **Orientation.** `kalg_minute_stats` stores yaw, atan2(y, x), rounded into 16
  bins in the low nibble. The high nibble is pitch, the angle from the watch's
  +z axis, which only reaches bins 0–8 (0–180°). Each is ±11.25°.
- **Light.** Apps only get the `AmbientLightLevel` enum. On the Pebble Time 2
  (`board_obelix.c`) the firmware splits it at a dark threshold of 800 lux ±
  100, so the levels are under 700, 700–800, 800–900 and from 900 lux. The
  outer two are open-ended, and the Observation's `code.text` says so. The
  emulator's board is uncalibrated, so emulator lux values mean nothing.

## Watch state

The watch persists the connection, which data types are checked (a bitmask,
all checked by default) and the last-sync times. "Connected" means a
connection has ever arrived. Sync Now is disabled until connected and shows
"Syncing..." until the phone answers, a send fails or the phone is quiet for
60 seconds. A success sets the overall and Health Activity's last-sync times to
when the sync started, and each checked minute type's to the start of that
hour. A failure titles the status row "Sync failed" until the next success or
restart. With nothing checked, Sync Now succeeds without asking the phone.

## Tests

`vp test --project fhir-sync-pebble-test` (the root `vp test` includes it):

- `menu-text.test.ts` compiles `menu-text.c` with `kitchen-sink/test`'s
  `buildHostCDriver` (host `cc`, C99, ASan + UBSan) and drives it through
  `menu-text-driver.c`, as `watch-lifts` does for its reps text.
- `settings.test.ts` tests `settings.js`, including the wire contract above.
- `health-activity.test.ts` and `minute-history.test.ts` test their modules,
  decoding the Observations they build with `fhir-r4`'s `Observation.Schema`.
- `minute-wire.test.ts` packs minutes with `minute-wire.c` through
  `minute-wire-driver.c`, then decodes the bytes with `minute-history.js`, so
  the two ends of the byte layout are tested together.

Each driver call spawns a process, so the C properties run fewer cases than
usual.

`sync.c` and the rest of the watch code need `pebble.h`, so only
`pebble build` compiles them.

## Traps

- **`struct tm` comes from `pebble.h`.** The SDK's libc `time.h` doesn't declare
  it, so `menu-text.h` includes `pebble.h` when `PBL_SDK_3` is defined and
  `<time.h>` otherwise.
- **PebbleKit JS is ES5 CommonJS.** Vitest's ESM transform can't load it; the
  test loads it with `createRequire`.
- **`package.json` is the Pebble manifest.** `pebble build` runs `npm install`
  if it lists dependencies, which fails on `catalog:` / `workspace:*`, so test
  dependencies go in `test/package.json`.
- **The app needs a `.bss`.** The SDK's `inject_metadata.py` sets the app
  header's `virtual_size` to the end of `.bss`, or of `.data` when there is no
  `.bss`, but the linker places `.got`/`.got.plt` after `.data`. With no
  zero-initialized global the load size exceeds `virtual_size` and the
  firmware silently refuses to start the app: it shows in the launcher, but
  selecting it logs nothing. `s_bss_anchor` in `fhir-sync-pebble.c` keeps a
  one-byte `.bss` after the GOT; `main` reads it so `--gc-sections` can't drop
  it. To check a build, `arm-none-eabi-readelf -S build/emery/pebble-app.elf`
  should list `.bss` last.
- **A new message key needs a clean build.** `pebble build` updates
  `build/appinfo.json` but not `build/include/message_keys.auto.h`, so a new
  `MESSAGE_KEY_*` is "undeclared" until `pebble clean`.
- **`pebble.h` defines `MINUTES_PER_HOUR`, `SECONDS_PER_HOUR` and friends.**
  Host-buildable headers that need their own (`minute-wire.h`) use other names.
- **Never renumber a persist key** (`state.c`): an installed watch still holds
  the old value under it.

C is formatted with clang-format (`vp run -F fhir-sync-pebble fmt:c`); CI
doesn't check it yet.
