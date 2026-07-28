import type { TraceExchange } from 'web-trace-core'

/** One captured response header, carrying the React key it is rendered under. */
interface KeyedHeader {
  readonly key: string
  readonly name: string
  readonly value: string
}

/**
 * Pair every captured header with a key that is unique across the list.
 *
 * @param headers - The exchange's response headers, as captured
 * @returns The same headers, in order, each with a distinct `key`
 *
 * @remarks
 * `name:value` alone is not unique: a response may repeat a header name *and*
 * its value (two identical `Vary` or `Set-Cookie` lines), and duplicate React
 * keys make the reconciler drop or mis-associate a row. Disambiguating by how
 * many identical pairs came before keeps the key data-dependent — a header that
 * does not move keeps its key even when a different one is added — which a bare
 * array index would not.
 *
 * Its own module rather than a helper beside the component: a file that exports
 * both a component and a function loses fast refresh.
 */
const keyedHeaders = (headers: TraceExchange['headers']): readonly KeyedHeader[] => {
  const seen = new Map<string, number>()
  return headers.map(([name, value]) => {
    const pair = `${name}:${value}`
    const occurrence = seen.get(pair) ?? 0
    seen.set(pair, occurrence + 1)
    return { key: `${pair}#${occurrence}`, name, value }
  })
}

export { keyedHeaders, type KeyedHeader }
