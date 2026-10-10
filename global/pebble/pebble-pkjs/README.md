# pebble-pkjs

Build tooling for a Pebble watchapp's PebbleKit JS written in TypeScript. The
Pebble SDK packs one JavaScript file, `src/pkjs/index.js`, and the phone runs
it on an ES5 runtime with no DOM; this package turns TypeScript sources, and
the workspace packages they import, into that file and proves it is ES5.

- `pkjsPack({ entry, outDir, alwaysBundle, es5Tsconfig })` — the `pack` block
  of the app's PebbleKit JS `vite.config.ts`.
- `lowerToEs5` and `checkEs5Library` (`src/es5.ts`) — the lowering and checks
  `pkjsPack` runs, exported for tests.
- `pebble-pkjs/pebble-kit-js` (`types/pebble-kit-js.d.ts`) — the PebbleKit JS
  globals: `Pebble`, `localStorage`, `XMLHttpRequest`, `setTimeout`,
  `clearTimeout` and `console`, as far as the apps built with it use them.
- `waf/pebble_pkjs.py` — `bundle_pkjs(ctx)`, which runs `vp pack` in the app's
  `pkjs/` from its wscript, before `pebble build` packs the bundle.

## Using it in a watchapp

The Pebble app's `package.json` is its Pebble manifest, and `pebble build` runs
`npm install` when it lists dependencies, which fails on `catalog:` and
`workspace:*`. So the PebbleKit JS is a package of its own, `pkjs/`, whose
`package.json` lists `pebble-pkjs` and the workspace packages it bundles.

`pkjs/vite.config.ts`:

```ts
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite-plus'

import { pkjsPack } from '../../../global/pebble/pebble-pkjs/src/index.ts'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  pack: pkjsPack({
    entry: { index: 'src/index.ts' },
    outDir: '../src/pkjs',
    alwaysBundle: ['my-app-core'],
    es5Tsconfig: fileURLToPath(new URL('src/tsconfig.json', import.meta.url)),
  }),
})
```

The config imports `pkjsPack` by path, as it does `vite.config.base.ts`: Vite
loads a config's package imports with Node, which reads a package's built
`default` export rather than its `source`.

`pkjs/src/tsconfig.json` is the ES5 program. It has `"lib": ["es5"]` and
`"types": ["@wildflowerhealthio/pebble-pkjs/pebble-kit-js"]`, and `"target": "es2015"` only because
`vp check`'s TypeScript 7 refuses ES5 (`checkEs5Library` checks it as ES5).
`pkjs/tsconfig.json` covers the Node-side config and tests.

The app's wscript imports the waf helpers from their directory, found from its
own:

```python
def build(ctx):
    ctx.load('pebble_sdk')

    sys.path.insert(0, ctx.path.find_dir('../../global/pebble/pebble-pkjs/waf').abspath())
    import pebble_pkjs
    pebble_pkjs.bundle_pkjs(ctx)
    ...
```

`bundle_pkjs` runs the workspace's `node_modules/.bin/vp`, found from the app's
directory upwards, else a `vp` on the `PATH`, so `vp install` must have run.

## Getting to ES5

Nothing in the Vite+ toolchain emits ES5. Rolldown refuses `target: 'es5'`,
and at ES2015 oxc lowers object spread through helpers that read `Symbol`; a
namespace used as a value also pulls in rolldown's `__exportAll`, which writes
`Symbol.toStringTag`. So `pkjsPack` sets `target: false` and, in
`generateBundle`, lowers the whole chunk with TypeScript 5's
`ts.transpileModule` at `ScriptTarget.ES5`, without comments. It has to be
`generateBundle`: rolldown reprints what `renderChunk` returns, turning
`{ a: a }` back into the ES2015 shorthand `{ a }`.

The lowered chunk must then parse as ES5 under acorn and read none of the later
globals `es5.ts` lists (`Symbol`, `Map`, `Promise`, `globalThis` and a few
more), or the build fails. Library methods don't lower, so before that
`checkEs5Library` type-checks every bundled source against the ES5 program,
workspace packages included: `Array.prototype.includes` or
`String.prototype.padStart` fails the build, and so does a bundled module
outside that program.

TypeScript 7 has no ES5 target, so `es5.ts` imports the bare `typescript`
package, which the catalog holds on 5.x.

## Traps

- **Nothing a bundled module imports may need ES2015 at run time**, Effect
  above all. Give a package the phone uses an Effect-free entry (a `./pkjs`
  export) whose modules import nothing else from the package, not even types:
  a type-only import of an Effect module drags about 550 files into the ES5
  program and slows the check by seconds.
- **The typings are for the ES5 program only.** Next to Node's or the DOM's
  they clash (`console`, `localStorage`, `XMLHttpRequest`), so they live in
  `types/` under an ES5 `tsconfig.json` of their own, outside `src/`.
