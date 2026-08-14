/*
 * Self-hosted web fonts for the Wildflower marketing site.
 *
 * The design system runs a single UI family — Atkinson Hyperlegible Next,
 * which `--font-sans` (and the retired `--font-serif`) resolve to — plus
 * Atkinson Hyperlegible Mono for genuine machine strings. These side-effect
 * imports ship the `@font-face` rules and bundled `woff2`s with the site
 * rather than fetching them from a third-party CDN at runtime. Same three
 * imports the app makes (`apps/medications-app/src/main.tsx`); the italic cut
 * carries the emphasis the marketing copy leans on.
 */
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
