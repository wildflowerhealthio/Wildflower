# watch-lifts

A Pebble watchapp/watchface written in C using the Pebble SDK.

## Building & running

```sh
pebble build                          # build for all targetPlatforms
pebble install --emulator emery       # install on the emery emulator
pebble install --phone <ip>           # install to a paired phone
```

## Tests and formatting

The reps and weight text (`reps-text.c`) is plain C, so the `watch-lifts-test`
package in `test/` builds it with the host `cc` under AddressSanitizer and tests
it, with no Pebble SDK needed. The build is `kitchen-sink/test`'s
`buildHostCDriver`, which `apps/fhir-sync-pebble` shares. Run it with `vp test --project watch-lifts-test`;
the root `vp test` includes it. It is a separate package because this
`package.json` is also the Pebble manifest, and `pebble build` runs
`npm install` if it lists any dependencies.

C is formatted with clang-format (`.clang-format`, set up to match the repo's
Prettier-style TypeScript formatting). Install it with `brew install clang-format`,
`apt install clang-format` or `pipx install clang-format`, then:

```sh
vp run -F watch-lifts fmt:c         # format src/ and test/
vp run -F watch-lifts fmt:c:check   # fail if anything isn't formatted
```

CI doesn't run `fmt:c:check` yet, so run it before pushing C changes.

## Target platforms

`targetPlatforms` in `package.json` controls which watches you build for. This
app targets only **emery** (Pebble Time 2). The other modern platforms are
**gabbro** (Pebble Round 2) and **flint** (Pebble 2 Duo); the original Pebble
platforms are aplite, basalt, chalk and diorite. Add any of them to
`targetPlatforms` to build for it.

## Project layout

```text
src/c/           C source for the watchapp
src/pkjs/        PebbleKit JS (phone-side) source, if any
worker_src/c/    Background worker source, if any
resources/       Images, fonts, and other bundled resources
package.json     Project metadata (UUID, platforms, resources, message keys)
wscript          Build rules — usually no need to edit
```

By default this project is configured as a watchapp. To make it a watchface,
set `pebble.watchapp.watchface` to `true` in `package.json`.

## Documentation

Full SDK docs, tutorials, and API reference: <https://developer.repebble.com>
