/*
 * Dark mode for the marketing site, driven the same way the app drives it.
 *
 * react-tundraish keys its dark palette solely off `:root[data-color-scheme='dark']`
 * (there is no `prefers-color-scheme` rule in its stylesheet), so the site has
 * to translate the OS preference into that attribute itself — mirroring the
 * app's `apply-color-scheme` / `add-os-color-scheme-listener` pair, minus the
 * embedded-WebView bridge the marketing site never needs.
 */

type ColorScheme = 'light' | 'dark'

/** Write the resolved scheme onto the document root — the single dark-mode trigger. */
const applyColorScheme = (scheme: ColorScheme): void => {
  document.documentElement.dataset.colorScheme = scheme
}

/**
 * Mirror the browser's OS colour preference onto `data-color-scheme` and keep it
 * in sync as the preference changes. Returns an unsubscribe function.
 */
const addOsColorSchemeListener = (): (() => void) => {
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

export { addOsColorSchemeListener, applyColorScheme }
export type { ColorScheme }
