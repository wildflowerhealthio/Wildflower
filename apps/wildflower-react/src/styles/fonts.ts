/*
 * Self-hosted web fonts for the Tundraish refresh.
 *
 * The design system's `--font-*` tokens (declared in
 * `react-tundraish/styles.css`) point at one UI family plus one mono; this
 * module loads them as side-effect imports of the `@fontsource-variable`
 * packages so the `@font-face` rules (and bundled `woff2`s) ship with the app
 * instead of being fetched from a third-party CDN at runtime. Bundling matters
 * for the Tauri host, which must render correctly offline and without a Google
 * Fonts dependency.
 *
 * Imported once from `app-root.tsx`, which every entry (`main-web` and the
 * Tauri shell via `wildflower-react/app-root`) routes through — so a single import covers every Tundraish surface.
 *
 *   - Atkinson Hyperlegible Next — the single UI family (body, labels, titles);
 *     the italic cut carries emphasis.
 *   - Atkinson Hyperlegible Mono — reserved for genuine machine strings.
 */
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'
