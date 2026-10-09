# AGENTS.md — apps/fhir-sync-pebble/fhir-sync-pebble-watchapp

FHIR Sync for Pebble, the watchapp: a C app for the watch and PebbleKit JS for
the phone. Its settings page is [`apps/fhir-sync-pebble/fhir-sync-pebble-web`](../fhir-sync-pebble-web/AGENTS.md),
where the user signs in to a FHIR server and confirms the patient. Sync Now
sends every checked data type: Health Activity from HealthService's
activities, the other five from its minute history.

`apps/watch-lifts` is the template for the shape: this `package.json` is the
Pebble manifest, and host-side tests live in a separate `test/` package. The
PebbleKit JS is TypeScript in a third, `pkjs/`, for the same reason: the
manifest can't list the dependencies its build needs. What the phone decodes
and the Observations it posts are `fhir-sync-pebble-core-js`'s (see
[apps/fhir-sync-pebble](../AGENTS.md)); `pkjs/`
is the glue to Pebble's events, AppMessage, `localStorage` and
`XMLHttpRequest`.

## Building and running

```sh
pebble build                          # build for targetPlatforms (emery only)
pebble install --emulator emery       # install on the emery emulator
pebble emu-app-config --emulator emery  # open the settings page for the emulator
pebble install --phone <ip>           # install to a paired phone
```

`pebble build` first runs `vp pack` in `pkjs/` (the wscript does, through
[`pebble-pkjs`](../../../global/pebble/pebble-pkjs/README.md)'s waf helpers),
which bundles the PebbleKit JS into `src/pkjs/index.js`, the one file the SDK
packs (gitignored). It runs the repository's `node_modules/.bin/vp`, so
`vp install` must have run (without it, a `vp` on the `PATH`), and Node must be
on the `PATH`. To build the bundle alone, `vp run -F fhir-sync-pebble-pkjs build`; `vp run pack` builds it
with the rest of the monorepo.

The Pebble SDK and the `pebble` tool are needed only for these; the tests use
the host `cc`.

## Layout

- `pkjs/src/index.ts` — the PebbleKit JS, thin glue over the core. Opens
  `https://wildflowerhealth.io/fhir-sync-pebble/` on `showConfiguration`, and
  on `webviewclosed` decodes the response (`PhoneSettings.decodeResponse`),
  keeps the full settings and when they arrived in `localStorage`
  (`PhoneSettings.toStored`) and sends the watch its part
  (`PhoneSettings.toWatchMessage`); on `ready` it sends that part again. On
  `appmessage` it folds each message into the sync under way with
  `WatchSync.receive` and does what that says; a complete sync goes through
  `WatchSync.planWrite`, and its transaction Bundle is posted with a 60 s
  timeout. It answers the watch exactly once per sync, with the sync's id.
  Everything it calls comes from `fhir-sync-pebble-core-js/pkjs`.
- `pkjs/src/tsconfig.json` — the ES5 program: ES5's library and no DOM, with
  the PebbleKit JS globals (`Pebble`, `localStorage`, `XMLHttpRequest`,
  `setTimeout`, `console`) from `pebble-pkjs/pebble-kit-js` in its `types`.
- `pkjs/vite.config.ts` — the bundle: `pebble-pkjs`'s `pkjsPack` bundles
  `src/index.ts` and the core into `../src/pkjs/index.js` as an IIFE, then
  lowers it to ES5, without comments, and checks it (see Traps).
- `src/pkjs/index.js` — that bundle, generated and gitignored.
- `src/c/fhir-sync-pebble.c` — `main` and the AppMessage callbacks. `main`
  owns the one `App` (the `AppState`, the settings window and the `Sync`) on
  its stack and passes it as the AppMessage context. The one file-scope static
  is the `.bss` anchor (see Traps).
- `src/c/sync.c` — `Sync`, one Sync Now run: collects the activities from
  HealthService, sends `SyncStart`, the activities and then each hour of
  minute history to the phone one message at a time, and ends the sync on the
  phone's answer to it, a failed send, a timeout or a change of connection.
- `src/c/minute-wire.c` — packs one minute of `HealthMinuteData` into the
  bytes an hour message carries, kept buildable on the host.
- `src/c/state.c` — `AppState`, the state behind the menu, and its persist
  storage. Readers read its fields; changes go through the `state_*`
  functions, which persist them. A connection to another patient or server
  starts the last-sync times over.
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
has none — AppMessage has no null), `AuthTime`, the Unix seconds at which the
phone received the settings, and `ConnectionId`, which patient on which server
(`PhoneSettings.connectionId`: `fhir-r4`'s `localResourceId` for the patient
id on the FHIR base URL). The token and FHIR base URL stay in PebbleKit JS's
`localStorage`, where the sync reads them.

The phone cuts the name to 63 bytes of UTF-8 and the birth date to 10, what
`state.h` keeps, between code points, so the watch never cuts a character in
half. The settings message is the largest the phone sends; a name long enough
to overflow the watch's inbox (`APP_MESSAGE_INBOX_SIZE`) would get the whole
message dropped. `PhoneSettings.toWatchMessage` works out the message's size
with every field at its longest, and `test/state.test.ts` checks the phone's
message against `state.h`'s sizes and the inbox.

The watch keeps its last-sync times across a new connection to the same
patient on the same server, a sign-in again to refresh the token included, and
starts them over at "never" for any other, so the next sync sends the new
patient everything the watch holds. A sync under way when the connection
changes is abandoned as failed.

The two ends can still disagree: the settings page can save while the
watchapp isn't running, so the send fails, or save mid-sync. So the phone
keeps the settings with when they arrived and sends them again whenever the
watchapp starts (`ready`), with the same `AuthTime`, and each sync carries the
watch's `ConnectionId`: a complete sync whose connection isn't the stored
settings' is answered 0 without a request, and the settings are sent again.
The watch's last-sync times are never written against another patient.

`PhoneSettings.decodeResponse` must accept exactly what the settings page's
`PebbleSettings.toJson` writes. `PebbleSettings.Schema` is pinned to
`PhoneSettings.Settings`, and the core's `phone-settings.test.ts` round-trips
generated settings through both to hold the two together.

## The sync's messages

Every message is `int32` but `MinuteData`:

- watch → phone, first: `SyncStart`, the sync's id, and `ConnectionId`, the
  connection the watch's last-sync times belong to (a string). The phone starts
  collecting afresh on it, so whatever a sync the watch gave up on left behind
  never counts against the next;
- watch → phone, one per activity: `ActivityType` (pebble.h's `HealthActivity`
  value, one bit each), `ActivityStart`, `ActivityEnd` (Unix seconds);
- watch → phone, then: one message per hour of minute history (see below);
- watch → phone, last: `ActivityCount` and `MinuteHourCount`, how many of each
  preceded it;
- phone → watch: `SyncSucceeded`, 1 when the server stored them all, and
  `SyncId`, the id `SyncStart` carried. The watch ignores an answer to any
  sync but the one under way, such as a late one to a sync it gave up on.

The sync's id is the Unix second it started, or the last id this run plus one
when a sync started in the same second as the one before.

The phone PUTs one transaction Bundle of every Observation to the FHIR base URL
with the stored token. It answers 0 if either count doesn't match what arrived,
any message fails to decode, the settings, watch info or watch token are
missing, the watch's connection isn't the stored settings', the request fails,
or the server hasn't answered within 60 s (`REQUEST_TIMEOUT_MS`). With nothing to post it answers 1 without a request.
With no sync started (the phone's JavaScript restarted mid-sync) it has no id
to answer with and doesn't; the watch's own timeout ends the sync.

The watch fails the sync if the phone takes 60 s to acknowledge a message, or
90 s to answer once it has the counts (`SYNC_RESULT_TIMEOUT_MS`): the phone's
60 s request timeout plus 30 s for building the Bundle and delivering the
answer, so the phone's timeout fires first and the watch still hears the
failure.

### Writes are idempotent

Every Observation has an id the watch's records determine, and the Bundle PUTs
each to `Observation/<id>`, so a record sent again replaces what was sent
before rather than adding a copy. That makes re-sending harmless: an activity
under way at one sync and longer at the next, an activity sent again by the
lookback, or a whole sync the server committed after the phone or watch gave
up. The id is `WatchDevice.observationId`: `fhir-r4`'s `localResourceId` over
the watch token (`Pebble.getWatchToken()`, unique to the watch and this app),
the patient id and the record's key, an activity's type and start or a minute
type and its hour. The patient is part of it so a new connection writes the new
patient's own Observations rather than moving the old one's. Each Observation's
`device` carries the watch token as its `identifier`, under the system
`https://developer.repebble.com/docs/pebblekit-js/Pebble/#getWatchToken`,
beside the model display. Without a token the phone fails the sync rather than
write ids no later sync reproduces.

The server must accept a PUT that creates a resource under a client-chosen id,
inside a transaction. HFS, which `emr-rust` embeds, does (`helios-rest`'s
transaction handler upserts a PUT entry).

## Health Activity sync

Sync Now, with Health Activity checked, iterates `health_service_activities_iterate`
from a day before Health Activity's last sync (`SYNC_ACTIVITY_LOOKBACK_SECONDS`)
to now and keeps each activity that ended in that span. HealthService
classifies some activities after they end, sleep above all, which it records
once the wearer wakes; the day of lookback catches a night classified after the
sync that followed it. The lookback moves only where the iteration starts: a
success still sets Health Activity's last sync to when the sync started. It
adds at most a day's activities to those the watch collects in memory before
sending. An activity whose start HealthService later moves lands as a second
Observation, since its id comes from its start.

The phone turns each activity into one Observation (see the core's
`HealthActivity` for the coding, from the HealthService docs page).

## Minute history sync

The other five data types come from `health_service_get_minute_history`, whole
UTC clock hours at a time. A sync covers from the oldest last-sync time among
the checked minute types (on a type's first sync, the oldest minute the watch
holds) up to the start of the hour the sync began in, which becomes those
types' last-sync time. A successful sync doesn't send an hour again, and one
sent again after a failed sync overwrites its Observations (see "Writes are
idempotent"). Each hour with a valid minute and a type still due is one
message:

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

The watch persists the connection, its connection id, which data types are
checked (a bitmask, all checked by default) and the last-sync times.
"Connected" means a connection has ever arrived; a connection to another
patient or server resets the last-sync times (see "What reaches the watch").
Sync Now is disabled until connected and shows "Syncing..." until the phone
answers, a send fails, the phone is quiet too long (see "The sync's messages")
or the connection changes. A success sets the overall and Health Activity's
last-sync times to when the sync started, and each checked minute type's to the
start of that hour. A failure titles the status row "Sync failed" until the next success or
restart. With nothing checked, Sync Now succeeds without asking the phone.

## Tests

What the phone decodes and builds is tested in `fhir-sync-pebble-core-js`, where
it lives. Here, `vp test --project fhir-sync-pebble-test` (the root `vp test`
includes it):

- `menu-text.test.ts` compiles `menu-text.c` with `kitchen-sink/test`'s
  `buildHostCDriver` (host `cc`, C99, ASan + UBSan) and drives it through
  `menu-text-driver.c`, as `watch-lifts` does for its reps text.
- `minute-wire.test.ts` packs minutes with `minute-wire.c` through
  `minute-wire-driver.c`, then decodes the bytes with the core's
  `MinuteHistory`, so the two ends of the byte layout are tested together.
- `state.test.ts` runs `state.c` through `state-driver.c`: the last-sync times
  kept across a sign-in again and reset for another connection, across
  restarts, and the core's settings message against `state.h`'s sizes and the
  inbox.
- `sync.test.ts` runs `sync.c` (with `state.c` and `minute-wire.c`) through
  `sync-driver.c`, which records AppMessages and the timer and scripts
  HealthService's activities: `SyncStart` first with its id and connection, the
  60 s and then 90 s timer, answers matched by id, `sync_abandon`, and the
  activity lookback.

`state.c` and `sync.c` include `pebble.h`, so their builds put
`test/pebble-stand-in/` on the include path (`buildHostCDriver`'s
`includeDirectories`): its `pebble.h` declares the SDK calls they make and the
drivers define them. One driver command line is one scenario. Each driver call
spawns a process, so the C properties run fewer cases than usual.

`vp test --project fhir-sync-pebble-pkjs` runs `src/index.ts` over stand-ins
for the PebbleKit JS globals with fake timers (`index.test.ts`): the settings sent again, one
answer per sync, the request timeout. What each message does is the core's
`WatchSync.receive`, tested there.

The rest of the watch code (the windows and views) needs more of `pebble.h`
than the stand-in has, so only `pebble build` compiles it.

## Traps

- **`struct tm` comes from `pebble.h`.** The SDK's libc `time.h` doesn't declare
  it, so `menu-text.h` includes `pebble.h` when `PBL_SDK_3` is defined and
  `<time.h>` otherwise.
- **PebbleKit JS runs ES5.** The build lowers the bundle to ES5 and fails on
  what ES5 lacks, syntax, globals or library methods alike, in every bundled
  source, the core's and `pebble-configuration`'s included (see
  [`pebble-pkjs`](../../../global/pebble/pebble-pkjs/README.md)).
  `pkjs/src/tsconfig.json` (the ES5 one) says ES2015 only because `vp check`'s
  TypeScript 7 refuses ES5, and `pkjs/tsconfig.json` covers the Node-side
  build files and tests.
- **Nothing the phone bundles may import Effect.** Effect needs ES2015 at run
  time, so the core's `pkjs` entry is Effect-free and its decoders are
  hand-written. Import `fhir-sync-pebble-core-js/pkjs`, not the package root,
  from `pkjs/`.
- **`package.json` is the Pebble manifest.** `pebble build` runs `npm install`
  if it lists dependencies, which fails on `catalog:` / `workspace:*`, so test
  dependencies go in `test/package.json` and the PebbleKit JS build's in
  `pkjs/package.json`.
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

C is formatted with clang-format (`vp run -F fhir-sync-pebble-watchapp fmt:c`), at the
version `ci-pebble.yml` pins: other releases format differently.

## CI

`.github/workflows/ci-pebble.yml`, on pull requests touching this app, its core,
`global/pebble` or `apps/watch-lifts`, runs `fmt:c:check` and both test
packages above, with `global/pebble`'s, in its
**Lint + Test** job, and `pebble build` in its **Build** job, which uploads
`fhir-sync-pebble-watchapp.pbw` (`pebble build` names it after this folder)
as a workflow artifact. See [`apps/watch-lifts`'s
README](../../watch-lifts/README.md#ci).

## Releases

The `version` in `package.json` comes from the Tauri release: Tauri Release —
Prepare writes it, less any prerelease suffix, and Publish attaches
`fhir-sync-pebble-<version>.pbw` to the GitHub Release. Don't bump it by hand.
For a non-prerelease Publish also uploads it to the app's Pebble app store
listing as an unpublished release; it never creates the listing, and never
publishes. See [`apps/watch-lifts`'s README](../../watch-lifts/README.md#releases)
and the [App Store Release Explanation](../../../docs/Pebble/App%20Store%20Release%20Explanation.md).
