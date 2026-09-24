/**
 * The whole Tundraish stylesheet stack, in its load-bearing order: tundra-css's
 * base tokens and reset, then this package's `styles.css` re-pointing them to
 * the Wildflower palette and type scale, then the Atkinson Hyperlegible faces
 * `--font-sans` / `--font-mono` resolve to. An app's entry imports this
 * (`import 'react-tundraish/styles'`) before anything else that carries CSS.
 *
 * @remarks
 * Side-effect imports rather than a stylesheet of `@import`s: the bundler
 * dedupes a stylesheet by module id, and `index.ts` imports `./styles.css`
 * too, so an app that still imports `tundra-css` or `react-tundraish/styles.css`
 * itself gets one copy of each. An `@import` is inlined, and would ship twice.
 * The pack extracts this package's own CSS into `dist/style.css`, so a built
 * (`default`-condition) consumer imports `react-tundraish/styles.css` as well,
 * exactly as it does alongside `dist/index.js`.
 */
import 'tundra-css'
import './styles.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'
