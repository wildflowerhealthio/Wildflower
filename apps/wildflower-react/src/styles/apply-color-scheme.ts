import type { ColorScheme } from 'navigation-react'

/**
 * Write the host's OS colour scheme onto the document root as an
 * authoritative `data-color-scheme` attribute. The stylesheet keys its dark
 * palette off `:root[data-color-scheme='dark']` and gates its
 * `prefers-color-scheme` fallback behind `:root:not([data-color-scheme])`,
 * so once this attribute is set it overrides the OS media query.
 *
 * Needed inside the embedded WebView because WKWebView evaluates
 * `prefers-color-scheme` as `light` for `loadHTMLString` content regardless
 * of the device appearance; the host relays the real scheme over the
 * Navigation bridge and this writer makes it stick. The plain web build
 * never receives the message, leaves the attribute unset, and stays driven
 * by `prefers-color-scheme`.
 */
const applyColorScheme = (scheme: ColorScheme): void => {
  document.documentElement.dataset.colorScheme = scheme
}

export { applyColorScheme }
