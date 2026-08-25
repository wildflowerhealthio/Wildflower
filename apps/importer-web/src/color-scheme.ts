/*
 * Colour-scheme wiring for the standalone importer app.
 *
 * The Tundraish stylesheet keys its dark palette solely off
 * `:root[data-color-scheme='dark']` — there is no `prefers-color-scheme`
 * fallback rule (see `react-tundraish/colors-custom.css`). A plain web build
 * therefore has to translate the OS media query into that attribute itself,
 * which is what this module does: mirror `matchMedia('(prefers-color-scheme:
 * dark)')` onto `document.documentElement.dataset.colorScheme` at boot and keep
 * it in sync as the preference changes.
 *
 * This is the standalone twin of `apps/wildflower-react`'s
 * `apply-color-scheme` / `add-os-color-scheme-listener` pair, copied from
 * `apps/web-trace`'s. A self-hosted bundle pulls in neither (it has no
 * navigation bridge, and its router is a memory router with no routes of its
 * own), so the minimal logic lives here.
 */

type ColorScheme = 'light' | 'dark'

const applyColorScheme = (scheme: ColorScheme): void => {
  document.documentElement.dataset.colorScheme = scheme
}

/**
 * Apply the OS colour preference now and re-apply on every change. Returns an
 * unsubscribe function that detaches the listener.
 */
const startColorSchemeSync = (): (() => void) => {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = (): void => {
    applyColorScheme(query.matches ? 'dark' : 'light')
  }
  apply()
  query.addEventListener('change', apply)
  return () => {
    query.removeEventListener('change', apply)
  }
}

export { applyColorScheme, startColorSchemeSync, type ColorScheme }
