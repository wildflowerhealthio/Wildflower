# AGENTS.md — apps/fhir-sync-pebble

FHIR Sync for Pebble, the watchapp: a C app for the watch and PebbleKit JS for
the phone. Its settings page is [`apps/fhir-sync-pebble-web`](../fhir-sync-pebble-web/AGENTS.md),
where the user signs in to a FHIR server and confirms the patient. Phase one is
the UI and the settings hand-off; nothing syncs yet.

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
  full settings in `localStorage` and sends the watch its part.
- `src/pkjs/settings.js` — the decode (`decodeResponse`) and the watch's
  message (`toWatchMessage`), free of Pebble globals so tests load it under
  Node; `settings.d.ts` types it for them.
- `src/c/fhir-sync-pebble.c` — `main` and the AppMessage inbox. `main` owns
  the one `App` (the `AppState` and the settings window) on its stack and
  passes it as the AppMessage context; there are no file-scope statics.
- `src/c/state.c` — `AppState`, the state behind the menu, and its persist
  storage. Readers read its fields; changes go through the `state_*`
  functions, which persist them.
- `src/c/windows/settings-window.c` — the app's one window, hosting the
  settings menu.
- `src/c/views/settings-menu-layer.c` — the `MenuLayer`, with the `AppState` as
  its callback context: row order, dispatch and the checkbox toggle. Each row
  kind draws itself from `views/settings-menu-layer/`: `status-row` (last sync,
  last sign-in), `patient-row` (name, birth date), `data-type-row` (a checkbox
  per `DataType`) and `sync-now-row`.
- `src/c/menu-text.c` — every row's text, kept buildable on the host.

## What reaches the watch

The settings carry a live access token, so only what the watch shows crosses
over AppMessage: `PatientName`, `PatientBirthDate` (each `""` when the record
has none — AppMessage has no null) and `AuthTime`, the Unix seconds at which the
phone received the settings. The token and FHIR base URL stay in PebbleKit JS's
`localStorage`, where the sync will need them.

`decodeResponse` must accept exactly what the settings page's
`PebbleSettings.toJson` writes; `test/settings.test.ts` round-trips generated
settings through both to hold the two together.

## Watch state

The watch persists the connection and which data types are checked (a bitmask,
all checked by default). "Connected" means a connection has ever arrived. The
last-sync times and the Sync Now loading state are in place but nothing sets
them yet; Sync Now is disabled until connected and otherwise does nothing.

## Tests

`vp test --project fhir-sync-pebble-test` (the root `vp test` includes it):

- `menu-text.test.ts` compiles `menu-text.c` with `kitchen-sink/test`'s
  `buildHostCDriver` (host `cc`, C99, ASan + UBSan) and drives it through
  `menu-text-driver.c`, as `watch-lifts` does for its reps text.
- `settings.test.ts` tests `settings.js`, including the wire contract above.

Each driver call spawns a process, so the C properties run fewer cases than
usual.

## Traps

- **`struct tm` comes from `pebble.h`.** The SDK's libc `time.h` doesn't declare
  it, so `menu-text.h` includes `pebble.h` when `PBL_SDK_3` is defined and
  `<time.h>` otherwise.
- **PebbleKit JS is ES5 CommonJS.** Vitest's ESM transform can't load it; the
  test loads it with `createRequire`.
- **`package.json` is the Pebble manifest.** `pebble build` runs `npm install`
  if it lists dependencies, which fails on `catalog:` / `workspace:*`, so test
  dependencies go in `test/package.json`.
- **Never renumber a persist key** (`state.c`): an installed watch still holds
  the old value under it.

C is formatted with clang-format (`vp run -F fhir-sync-pebble fmt:c`); CI
doesn't check it yet.
