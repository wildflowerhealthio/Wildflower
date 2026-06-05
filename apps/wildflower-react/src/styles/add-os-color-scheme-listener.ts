import { applyColorScheme } from './apply-color-scheme.ts'

/**
 * Mirror the browser's OS colour preference onto the document root as the
 * authoritative `data-color-scheme` attribute, and keep it in sync as the
 * preference changes.
 *
 * The stylesheet keys its dark palette solely off
 * `:root[data-color-scheme='dark']`; there is no `prefers-color-scheme`
 * fallback rule. The plain web build therefore has to translate the OS media
 * query into the attribute itself, which is what this does:
 * `matchMedia('(prefers-color-scheme: dark)')` gives the current preference
 * and fires on change. The embedded WebView never calls this — its host
 * relays the real scheme over the Navigation bridge instead (WKWebView
 * reports `light` for `loadHTMLString` content regardless of device
 * appearance), so the two paths converge on the same attribute writer.
 *
 * Returns an unsubscribe function that removes the change listener.
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

export { addOsColorSchemeListener }
