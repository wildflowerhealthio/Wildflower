# AGENTS.md — apps/fhir-sync-pebble

FHIR Sync for Pebble, the watchapp: a C app for the watch and PebbleKit JS for
the phone. Its settings page is [`apps/fhir-sync-pebble-web`](../fhir-sync-pebble-web/AGENTS.md),
where the user signs in to a FHIR server and confirms the patient. Of the data
types, only Health Activity syncs so far.

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
  `appmessage` it collects a sync's activities and posts them to the server.
- `src/pkjs/settings.js` — the decodes (`decodeResponse`, and `decodeStored`
  for what `localStorage` holds) and the watch's message (`toWatchMessage`),
  free of Pebble globals so tests load it under Node; `settings.d.ts` types it
  for them.
- `src/pkjs/health-activity.js` — the same for the sync: decodes the watch's
  activity messages and builds the Observations and their transaction Bundle;
  `health-activity.d.ts` types it.
- `src/c/fhir-sync-pebble.c` — `main` and the AppMessage callbacks. `main`
  owns the one `App` (the `AppState`, the settings window and the `Sync`) on
  its stack and passes it as the AppMessage context. The one file-scope static
  is the `.bss` anchor (see Traps).
- `src/c/sync.c` — `Sync`, one Sync Now run: collects the activities from
  HealthService, sends them to the phone one message at a time and ends the
  sync on the phone's answer, a failed send or a timeout.
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
- watch → phone, last: `ActivityCount`, how many activity messages preceded it;
- phone → watch: `SyncSucceeded`, 1 when the server stored them all.

The phone posts one transaction Bundle of Observations (see
`health-activity.js` for the coding, from the HealthService docs page) to the
FHIR base URL with the stored token, and answers 0 if the count doesn't match
what arrived, any message fails to decode, the settings are missing or the
request fails. With no activities it answers 1 without a request. There is no
server-side dedup.

## Watch state

The watch persists the connection, which data types are checked (a bitmask,
all checked by default) and the last-sync times. "Connected" means a
connection has ever arrived. Sync Now is disabled until connected and shows
"Syncing..." until the phone answers, a send fails or the phone is quiet for
60 seconds. A success sets the overall and each synced type's last-sync time to
when the sync started; a failure titles the status row "Sync failed" until the
next success or restart. Unchecked Health Activity makes Sync Now a success
with nothing to send.

## Tests

`vp test --project fhir-sync-pebble-test` (the root `vp test` includes it):

- `menu-text.test.ts` compiles `menu-text.c` with `kitchen-sink/test`'s
  `buildHostCDriver` (host `cc`, C99, ASan + UBSan) and drives it through
  `menu-text-driver.c`, as `watch-lifts` does for its reps text.
- `settings.test.ts` tests `settings.js`, including the wire contract above.
- `health-activity.test.ts` tests `health-activity.js`, decoding the
  Observations it builds with `fhir-r4`'s `Observation.Schema`.

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
- **Never renumber a persist key** (`state.c`): an installed watch still holds
  the old value under it.

C is formatted with clang-format (`vp run -F fhir-sync-pebble fmt:c`); CI
doesn't check it yet.
