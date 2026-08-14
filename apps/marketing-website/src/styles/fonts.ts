/*
 * Self-hosted web fonts for the Wildflower marketing site.
 *
 * The landing page's `--font-*` tokens reference the same three families as
 * the app (Hanken Grotesk, Newsreader, Spline Sans Mono); these side-effect
 * imports ship the `@font-face` rules and bundled `woff2`s with the site
 * rather than fetching them from a third-party CDN at runtime.
 */
import '@fontsource-variable/hanken-grotesk/wght.css'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource-variable/spline-sans-mono/wght.css'
