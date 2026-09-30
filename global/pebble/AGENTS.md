# AGENTS.md — global/pebble

What a Pebble watchapp with a TypeScript PebbleKit JS and a hosted settings page
needs, whatever the app does. This is `global/` code: project-agnostic, no
FHIR, no app's settings shape. The apps and their slices supply those and
build on these packages.

## Guardrails

- **The phone runs ES5.** Everything a watchapp's PebbleKit JS bundles is
  lowered to ES5 and checked against ES5's library, workspace packages
  included. A package the phone uses exposes an Effect-free `./pkjs` entry, as
  `pebble-configuration` does.
- **`return_to` is allow-listed.** Only the Pebble phone app and a local
  emulator may receive a settings page's hand-off; see the
  [pebble-configuration README](./pebble-configuration/README.md).

## Traps

- A PebbleKit JS `vite.config.ts` imports `pebble-pkjs` by path, not by package
  name: Vite loads a config's package imports with Node, which reads the
  unbuilt package's `default` export and fails.
- The PebbleKit JS typings clash with Node's and the DOM's, so they stay out of
  any program but an app's ES5 one.

## References

- [pebble-pkjs README](./pebble-pkjs/README.md) — the ES5 bundle, the typings, the waf helpers
- [pebble-configuration README](./pebble-configuration/README.md) — `ReturnTarget`, `ReturnTargetStore`, `decodeWebviewResponse`
