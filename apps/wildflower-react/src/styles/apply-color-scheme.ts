import type { ColorScheme } from 'navigation-react'

/**
 * Write a colour scheme onto the document root as the authoritative
 * `data-color-scheme` attribute. The stylesheet keys its dark palette solely
 * off `:root[data-color-scheme='dark']`, so this attribute is the single
 * trigger for dark mode — there is no `prefers-color-scheme` fallback rule.
 *
 * Both runtimes funnel through here. The embedded WebView relays the real
 * device scheme over the Navigation bridge — WKWebView evaluates
 * `prefers-color-scheme` as `light` for `loadHTMLString` content regardless
 * of device appearance, so it can't read the OS preference itself. The plain
 * web build derives the scheme from `prefers-color-scheme` via
 * `addOsColorSchemeListener` and writes it through the same attribute.
 */
const applyColorScheme = (scheme: ColorScheme): void => {
  document.documentElement.dataset.colorScheme = scheme
}

export { applyColorScheme }
