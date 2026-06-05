import type { ColorScheme } from 'navigation-react'

/**
 * Write a colour scheme onto the document root as the authoritative
 * `data-color-scheme` attribute. The stylesheet keys its dark palette solely
 * off `:root[data-color-scheme='dark']`, so this attribute is the single
 * trigger for dark mode — there is no `prefers-color-scheme` fallback rule.
 *
 * Both runtimes funnel through here: the embedded WebView relays the device
 * scheme over the Navigation bridge (see `HostColorSchemeChanged` for why it
 * can't read `prefers-color-scheme` itself), and the plain web build derives
 * it from `prefers-color-scheme` via `addOsColorSchemeListener`.
 */
const applyColorScheme = (scheme: ColorScheme): void => {
  document.documentElement.dataset.colorScheme = scheme
}

export { applyColorScheme }
