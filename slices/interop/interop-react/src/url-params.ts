import { Option, Schema } from 'effect'
import { Surface } from 'interop-core'

/** Read a URL query-string parameter without mutating the address bar. */
const readUrlParam = (key: string): string | null => {
  if (typeof window === 'undefined') return null
  return new URL(window.location.href).searchParams.get(key)
}

/**
 * Read a URL query-string parameter and strip it from the address bar via
 * `history.replaceState`. Used for one-shot bootstrap params (e.g. `?token=`)
 * that should not persist in browser history or `Referer` headers.
 */
const consumeUrlParam = (key: string): string | null => {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const value = url.searchParams.get(key)
  if (value === null) return null
  url.searchParams.delete(key)
  window.history.replaceState(null, '', url.toString())
  return value
}

const tryDecodeSurfaceFromUnknown = Schema.decodeUnknownOption(Surface.Schema)

/**
 * Returns `'expo'` when the page is running inside the Expo embedded
 * surface (signaled via `?surface=expo`), `null` otherwise.
 */
const readSurface = (): typeof Surface.Schema.Type | null => {
  const value = readUrlParam(Surface.key)
  return tryDecodeSurfaceFromUnknown(value).pipe(Option.getOrNull)
}

export { consumeUrlParam, readSurface, readUrlParam }
