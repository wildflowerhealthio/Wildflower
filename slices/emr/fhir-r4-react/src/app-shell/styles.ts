/*
 * The stylesheet stack every self-hosted SMART app loads, in its load-bearing
 * order, so an app's entry imports this one module
 * (`import 'fhir-r4-react/app-shell/styles'`) ahead of its own CSS modules:
 *
 *   1. tundra-css                  — the base tokens and reset
 *   2. react-tundraish/styles.css  — re-points them to the Wildflower palette
 *                                    and type scale
 *   3. branding-react/styles.css   — the layout tokens (--content-max-width,
 *                                    --page-padding-x, ...); after
 *                                    react-tundraish because they reference
 *                                    its --space-N ramps
 *   4. Atkinson Hyperlegible Next  — the self-hosted UI font `--font-sans`
 *                                    resolves to, upright and italic (the
 *                                    italic cut carries emphasis)
 *   5. Atkinson Hyperlegible Mono  — reserved for machine strings
 *
 * A module of side-effect imports rather than a stylesheet of `@import`s:
 * `react-tundraish` and `branding-react` also import their own `styles.css`
 * from their JS entries, and the bundler dedupes a stylesheet by module id —
 * a CSS `@import` is inlined instead, so the stack would ship twice.
 *
 * The launch page loads the same stack: a `@font-face` rule downloads its
 * font file only when a rendered glyph uses that face, so the cuts the launch
 * page never shows cost it nothing.
 */
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'branding-react/styles.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'
