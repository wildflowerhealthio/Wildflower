# watch-lifts

WatchLifts, a Pebble watchapp for a barbell program: the exercises, each
person's weight at each, and the sets and reps. It is C for the watch and
PebbleKit JS for the phone, which opens the weights settings page and passes
what it saves on to the watch.

## Building & running

```sh
pebble build                            # build for all targetPlatforms
pebble install --emulator emery         # install on the emery emulator
pebble emu-app-config --emulator emery  # open the settings page for the emulator
pebble install --phone <ip>             # install to a paired phone
```

`pebble build` first runs `vp pack` in `pkjs/` (the wscript does, through
[`pebble-pkjs`](../../global/pebble/pebble-pkjs/README.md)'s waf helpers),
which bundles the PebbleKit JS into `src/pkjs/index.js`, the one file the SDK
packs (gitignored). It runs the repository's `node_modules/.bin/vp`, so
`vp install` must have run (without it, a `vp` on the `PATH`), and Node must be
on the `PATH`. To build the bundle alone, `vp run -F watch-lifts-pkjs build`.

## Settings

The weights are set on the phone, on the page at
`https://wildflowerhealth.io/watch-lifts/`: a table of every person's weight at
every exercise, in whole pounds from 0 to 999, built from
[`apps/watch-lifts-web`](../watch-lifts-web/AGENTS.md). It follows
developer.repebble.com's "App Configuration (Static)", as
`apps/fhir-sync-pebble/fhir-sync-pebble-watchapp` does:

- `showConfiguration`: the PebbleKit JS (`pkjs/src/index.ts`) opens the page
  with the current weights in its `weights` query parameter
  (`PhoneSettings.configurationUrl`): the ones last saved, or the defaults
  before any are. The phone app adds `return_to`.
- The page hands the weights back to `return_to` as their JSON, URI-encoded
  (`pebble-configuration`'s `ReturnTarget.handoffUrl`).
- `webviewclosed`: the PebbleKit JS decodes the response
  (`PhoneSettings.decodeResponse`), keeps it in `localStorage` and sends the
  watch the weights. An empty response means the page closed without saving,
  and changes nothing.
- `ready`: when the watchapp starts, the PebbleKit JS sends the weights last
  saved again, so a save made while the watchapp wasn't running still arrives.
  Before any save it sends nothing.

The JSON, both in the query parameter and handed back, is
`{"weights":[[60,50,50,50,85],[65,55,55,45,85]]}`: one row per person (Ruth,
Chloe), one weight per exercise (Squat, Bench Press, Bent Over Row, Overhead
Press, Deadlift), in that order. The page writes it with `watch-lifts-core`'s
`LiftSettings.toJson`, and `PhoneSettings.decodeResponse` accepts exactly that
(see [slices/watch-lifts](../../slices/watch-lifts/AGENTS.md)).

The watch persists the weights it receives (`state_set_weights`, persist key
`PersistKeyWeights`) and reads them back at start (`state_load`), falling back
to the defaults in `src/c/state.c` when none are stored. The exercise list
redraws as a message arrives; an exercise already open shows the new weights
the next time it opens.

## Wire

One AppMessage, phone to watch, with one key, `Weights`: a byte array of 20
bytes, every person's weight at every exercise as an unsigned 16-bit integer,
low byte first, person-major (Ruth's five, then Chloe's). The phone encodes it
with `PhoneSettings.toWatchMessage`, and the watch decodes it with
`weights_wire_decode` (`src/c/weights-wire.c`), which refuses a message of any
other length or with a weight over 999, leaving the weights as they were. The
watch opens its inbox at `WEIGHTS_WIRE_INBOX_SIZE`, the message's 28 bytes; it
sends the phone nothing.

## Traps

- **Never renumber a persist key** (`state.c`): an installed watch still holds
  the old value under it.
- **A new message key needs a clean build.** `pebble build` updates
  `build/appinfo.json` but not `build/include/message_keys.auto.h`, so a new
  `MESSAGE_KEY_*` is "undeclared" until `pebble clean`.
- **PebbleKit JS runs ES5**, so `pkjs/` imports `watch-lifts-core/pkjs`, never
  the package root, which needs Effect. The build lowers the bundle to ES5
  and fails on what ES5 lacks (see
  [`pebble-pkjs`](../../global/pebble/pebble-pkjs/README.md)).
- **The app needs a `.bss`** after the GOT, or the firmware silently refuses
  to start it (see `apps/fhir-sync-pebble/fhir-sync-pebble-watchapp`'s AGENTS.md). This app's
  zero-initialized globals, `s_weights` among them, give it one;
  `arm-none-eabi-readelf -S build/emery/pebble-app.elf` should list `.bss`
  last.

## Tests and formatting

The C the tests reach is built with the host `cc` under AddressSanitizer and
UBSan by the `watch-lifts-test` package in `test/`, with no Pebble SDK needed.
The build is `kitchen-sink/test`'s `buildHostCDriver`, which
`apps/fhir-sync-pebble/fhir-sync-pebble-watchapp` shares:

- `reps-text.test.ts` drives the reps and weight text (`reps-text.c`) through
  `reps-text-driver.c`.
- `weights-wire.test.ts` feeds `weights_wire_decode` the bytes
  `watch-lifts-core`'s `PhoneSettings.toWatchMessage` sends, through
  `weights-wire-driver.c`, so the two ends of the wire are tested together.
- `state.test.ts` runs `state.c` through `state-driver.c`: the weights kept
  across a restart under persist key 1, the fallback to the defaults, and
  `watch-lifts-core`'s `Lifts` (the exercises, people and default weights the
  page and phone use) against `state.c`'s. `state.c` includes `pebble.h`, so
  its build puts `test/pebble-stand-in/` on the include path: its `pebble.h`
  declares the persist calls, and the driver keeps them in memory.

`vp test --project watch-lifts-pkjs` runs the PebbleKit JS over stand-ins for
the PebbleKit JS globals (`pkjs/index.test.ts`). Run the C ones with
`vp test --project watch-lifts-test`; the root `vp test` includes both.
`test/` and `pkjs/` are separate packages because this `package.json` is also
the Pebble manifest, and `pebble build` runs `npm install` if it lists any
dependencies.

C is formatted with clang-format (`.clang-format`, set up to match the repo's
Prettier-style TypeScript formatting). Its output moves between releases, so
install the version `.github/workflows/ci-pebble.yml` pins, with
`pipx install clang-format==<version>` or `uv tool install clang-format==<version>`,
then:

```sh
vp run -F watch-lifts fmt:c         # format src/ and test/
vp run -F watch-lifts fmt:c:check   # fail if anything isn't formatted
```

## CI

`.github/workflows/ci-pebble.yml` runs on pull requests that touch this app,
`apps/fhir-sync-pebble`, either's slice or `global/pebble`, as two jobs covering both apps: **Lint + Test** runs
`fmt:c:check` and the host-side tests, and **Build** runs `pebble build` and
uploads each `.pbw` as a workflow artifact named after its app, ready to
sideload. The pebble-tool and SDK versions it builds with are pinned in
`.github/actions/setup-pebble-sdk`.

## Releases

This app and `apps/fhir-sync-pebble/fhir-sync-pebble-watchapp` ship with the Tauri app's releases, not on
their own. **Tauri Release — Prepare** (`.github/workflows/tauri-release-prepare.yml`)
writes the release version into both apps' `package.json` `version`, so don't
bump it by hand. `pebble build` accepts only `MAJOR.MINOR.PATCH` with major and
minor in 0–255, so a prerelease is dropped: release `1.2.3-beta.1` builds as
`1.2.3`, and Prepare fails on a major or minor over 255. The watch itself sees
only `MAJOR.MINOR` (`PebbleProcessInfo.process_version`); the `.pbw` and the
app store keep the patch. Once the release PR merges, **Tauri Release — Publish**
builds both apps from the tag and attaches `watch-lifts-<version>.pbw` and
`fhir-sync-pebble-<version>.pbw`, named with the full release version, to the
draft GitHub Release. Its `platforms` input takes `pebble` to rebuild just
these. For a non-prerelease it then uploads both to their Pebble app store
listings as unpublished releases, which you publish from the store dashboard;
the first release of each app is uploaded by hand. The secret it needs and why:
[App Store Release Explanation](../../docs/Pebble/App%20Store%20Release%20Explanation.md).

## Target platforms

`targetPlatforms` in `package.json` controls which watches you build for. This
app targets only **emery** (Pebble Time 2). The other modern platforms are
**gabbro** (Pebble Round 2) and **flint** (Pebble 2 Duo); the original Pebble
platforms are aplite, basalt, chalk and diorite. Add any of them to
`targetPlatforms` to build for it.

## Project layout

```text
src/c/           C source for the watchapp
src/pkjs/        The PebbleKit JS bundle, built from pkjs/ (gitignored)
pkjs/            The PebbleKit JS, in TypeScript (watch-lifts-pkjs)
test/            Host-side tests of the C (watch-lifts-test)
resources/       Images, fonts, and other bundled resources
package.json     Project metadata (UUID, platforms, resources, message keys)
wscript          Build rules: bundles pkjs/, then the SDK's defaults
```

By default this project is configured as a watchapp. To make it a watchface,
set `pebble.watchapp.watchface` to `true` in `package.json`.

## Documentation

Full SDK docs, tutorials, and API reference: <https://developer.repebble.com>
