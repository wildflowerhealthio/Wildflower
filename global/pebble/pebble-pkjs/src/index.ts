/**
 * The build side of a Pebble watchapp's PebbleKit JS written in TypeScript:
 * the `vp pack` config that bundles it to the one ES5 file the Pebble SDK
 * reads, and the ES5 lowering and checks that config runs.
 *
 * - {@link pkjsPack} — the `pack` block of the app's PebbleKit JS
 *   `vite.config.ts`.
 * - {@link lowerToEs5} and {@link checkEs5Library} — the ES5 lowering and the
 *   checks on its syntax, globals and library.
 *
 * The PebbleKit JS globals' types are `pebble-pkjs/pebble-kit-js`, which an
 * app's ES5 `tsconfig.json` lists in `types`; the waf helpers that run the
 * bundle before `pebble build` are `waf/pebble_pkjs.py`.
 *
 * @packageDocumentation
 */
export { checkEs5Library, lowerToEs5 } from './es5.ts'
export { pkjsPack, type PkjsPackOptions } from './pkjs-pack.ts'
