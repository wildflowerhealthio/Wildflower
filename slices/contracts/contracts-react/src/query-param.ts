import { ContractQueryParam } from 'contracts-core'
import { Option, Schema } from 'effect'

/** Read a URL query-string parameter without mutating the address bar. */
const readQueryParam = (key: string): string | null => {
  if (typeof window === 'undefined') return null
  return new URL(window.location.href).searchParams.get(key)
}

/**
 * Read a URL query-string parameter and strip it from the address bar via
 * `history.replaceState`. Used for one-shot bootstrap params (e.g. `?token=`)
 * that should not persist in browser history or `Referer` headers.
 */
const consumeQueryParam = (key: string): string | null => {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const value = url.searchParams.get(key)
  if (value === null) return null
  url.searchParams.delete(key)
  window.history.replaceState(null, '', url.toString())
  return value
}

const tryDecodeHostTypeFromUnknown = Schema.decodeUnknownOption(ContractQueryParam.HostType.Schema)

/**
 * Returns `'expo'` when the page is running inside the Expo embedded
 * host (signaled via `?host=expo`), `null` otherwise.
 */
const readHostType = (): typeof ContractQueryParam.HostType.Schema.Type | null => {
  const value = readQueryParam(ContractQueryParam.HostType.key)
  return tryDecodeHostTypeFromUnknown(value).pipe(Option.getOrNull)
}

export { consumeQueryParam, readQueryParam, readHostType }
