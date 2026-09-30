import type { PackUserConfig } from 'vite-plus/pack'

import { checkEs5Library, lowerToEs5 } from './es5.ts'

/** What {@link pkjsPack} needs from the app. */
interface PkjsPackOptions {
  /** The PebbleKit JS sources to bundle, by output name: `{ index: 'src/index.ts' }`. */
  readonly entry: Readonly<Record<string, string>>
  /** Where the Pebble SDK reads the bundle from, the app's `src/pkjs`. */
  readonly outDir: string
  /**
   * The workspace packages to bundle from source, as the workspace resolves
   * them, rather than leave as imports the phone can't resolve.
   */
  readonly alwaysBundle: ReadonlyArray<string>
  /**
   * The absolute path of the ES5 `tsconfig.json` every bundled module must be
   * in, with ES5's `lib` alone (see `checkEs5Library`).
   */
  readonly es5Tsconfig: string
}

/**
 * The `pack` block of a watchapp's PebbleKit JS `vite.config.ts`: `vp pack`
 * bundles the entry and the workspace packages it imports into one ES5 file,
 * where the Pebble SDK reads it.
 *
 * @remarks
 * `generateBundle` lowers the finished bundle with {@link lowerToEs5}, after
 * {@link checkEs5Library} has type-checked every module in it against ES5's
 * library; either fails the build.
 */
const pkjsPack = ({
  entry,
  outDir,
  alwaysBundle,
  es5Tsconfig,
}: PkjsPackOptions): PackUserConfig => ({
  entry: { ...entry },
  outDir,
  // The Pebble SDK's webpack wraps the file as a module of its own.
  format: 'iife',
  outputOptions: { entryFileNames: '[name].js' },
  // Bundle the workspace packages from source, as the workspace resolves them.
  inputOptions: { resolve: { conditionNames: ['source', 'import', 'default'] } },
  platform: 'neutral',
  // TypeScript lowers the whole bundle to ES5 in generateBundle; oxc stops at
  // ES2015 and would lower some syntax with helpers ES5 lacks.
  target: false,
  dts: false,
  exports: false,
  clean: false,
  hash: false,
  deps: { resolveDepSubpath: true, alwaysBundle: [...alwaysBundle] },
  plugins: [
    {
      name: 'pebble-pkjs:es5',
      // The last hook before the file is written: rolldown reprints the
      // code renderChunk returns, restoring ES2015 shorthand.
      generateBundle: (_, bundle) => {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') {
            checkEs5Library(es5Tsconfig, output.moduleIds)
            output.code = lowerToEs5(output.code)
          }
        }
      },
    },
  ],
})

export { pkjsPack }
export type { PkjsPackOptions }
