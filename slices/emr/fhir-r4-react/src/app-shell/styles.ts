/**
 * The stylesheet stack every self-hosted SMART app loads, in its load-bearing
 * order: tundra-css's base tokens and reset, react-tundraish's Wildflower
 * palette and type scale over them, branding-react's layout tokens (which
 * reference tundraish's `--space-N` ramps), then the self-hosted Atkinson
 * faces. An app's entry imports this module ahead of its own CSS modules.
 *
 * @remarks
 * Side-effect imports rather than a stylesheet of `@import`s, because the
 * bundler dedupes a stylesheet by module id and `react-tundraish` /
 * `branding-react` import their own `styles.css` from their JS entries too; an
 * `@import` is inlined and ships the stack twice. The launch page loads the
 * whole stack: a `@font-face` fetches its file only when a glyph uses it.
 */
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'branding-react/styles.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'
