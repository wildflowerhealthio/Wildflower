/*
 * Self-hosted web fonts for the Tundraish "Wildflower" refresh.
 *
 * The design system's `--font-*` tokens (declared in
 * `react-tundraish/styles.css`) point at three families; this module loads
 * them as side-effect imports of the `@fontsource-variable` packages so the
 * `@font-face` rules (and bundled `woff2`s) ship with the app instead of
 * being fetched from a third-party CDN at runtime. Bundling matters for the
 * Tauri host, which must render correctly offline and without a Google Fonts
 * dependency.
 *
 * Imported once from `app-root.tsx`, which every entry (`main-web`,
 * `main-single-web`, and the Tauri shell via `wildflower-react/app-root`)
 * routes through — so a single import covers every Tundraish surface.
 *
 *   - Hanken Grotesk — the working UI + body voice (weight axis).
 *   - Newsreader — serif accents (titles & emphasis); the optical-size axis
 *     keeps it readable at title sizes, with an italic cut for emphasis.
 *   - Spline Sans Mono — eyebrows, labels, and technical metadata.
 */
import '@fontsource-variable/hanken-grotesk/wght.css'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource-variable/spline-sans-mono/wght.css'
