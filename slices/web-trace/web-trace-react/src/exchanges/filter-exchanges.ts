import type { TraceExchange } from 'web-trace-core'

import { mediaTypeOf } from '../attachments/viewable-attachment.ts'

/**
 * The exchange list's filters: URL, status, and content type.
 *
 * @remarks
 * Filtering is presentation, not selection — every filter narrows the exchanges
 * a session already holds, and none of them re-queries. The viewer shows raw
 * captured values throughout; nothing here redacts, and nothing here needs to.
 */

/**
 * A status filter: a response class, or `all`.
 *
 * @remarks
 * `other` is a real class, not a catch-all for the impossible: the sniffer
 * reports `status: 0` for opaque CORS responses and aborted requests, and those
 * are exactly the rows a collector author wants to find.
 */
type StatusClass = 'all' | '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other'

/** Every {@link StatusClass} a real status can fall into, in ascending order. */
const STATUS_CLASSES: readonly Exclude<StatusClass, 'all'>[] = [
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  'other',
]

/** The value both select filters use for "do not narrow on this axis". */
const ANY = 'all'

/** What the exchange list is currently narrowed to. */
interface ExchangeFilters {
  /** Case-insensitive substring matched against the exchange URL. Empty matches everything. */
  readonly urlQuery: string
  /** Response class to keep, or `all`. */
  readonly statusClass: StatusClass
  /** Normalised content type to keep, or `all`. */
  readonly contentType: string
}

/** Filters that narrow nothing — the exchange list's initial state. */
const NO_FILTERS: ExchangeFilters = { urlQuery: '', statusClass: ANY, contentType: ANY }

/**
 * The comparable form of a content type: lower-cased, parameters dropped.
 *
 * @param contentType - A body's content type as captured
 * @returns The media type alone, e.g. `application/json` for
 *   `application/json; charset=utf-8`
 *
 * @remarks
 * Dropping parameters keeps one endpoint from appearing as several content types
 * because a charset came and went. This is the filter's key; the captured value
 * itself is untouched. The filter's name for {@link mediaTypeOf}, and the same
 * function, so a body cannot classify one way here and another in the viewer.
 */
const normalizeContentType = mediaTypeOf

/**
 * The distinct content types present, as filter options.
 *
 * @param exchanges - The exchanges the list is drawn from, unfiltered
 * @returns The normalised content types, alphabetically, with no empty entry
 *
 * @remarks
 * Derived from the data: the capture stores bodies of any content type, so a
 * fixed list would hide whatever it did not anticipate. A body with no content
 * type contributes no option and is reachable only through `all`.
 */
const contentTypeOptions = (exchanges: readonly TraceExchange[]): readonly string[] =>
  [...new Set(exchanges.map((exchange) => normalizeContentType(exchange.body.contentType)))]
    .filter((contentType) => contentType !== '')
    .toSorted((left, right) => left.localeCompare(right))

/**
 * The hundreds digit of a status code to its class. Anything absent from this
 * map — including the `0` the sniffer reports for an opaque or aborted response
 * — is `other`.
 */
const STATUS_CLASS_BY_HUNDREDS: Readonly<Record<number, Exclude<StatusClass, 'all'>>> = {
  1: '1xx',
  2: '2xx',
  3: '3xx',
  4: '4xx',
  5: '5xx',
}

/**
 * The response class a status code falls into.
 *
 * @param status - The status the sniffer reported
 * @returns The matching {@link StatusClass}, or `other` for a code outside
 *   100–599 — including the `0` that marks an opaque or aborted response
 */
const statusClassOf = (status: number): Exclude<StatusClass, 'all'> =>
  STATUS_CLASS_BY_HUNDREDS[Math.floor(status / 100)] ?? 'other'

/**
 * Narrows exchanges to those matching every active filter.
 *
 * @param exchanges - The session's exchanges, in their existing order
 * @param filters - The active filters
 * @returns The matching exchanges, order preserved
 *
 * @remarks
 * The three axes conjoin, and each is independently neutral at its `all` /
 * empty value — so `filterExchanges(exchanges, NO_FILTERS)` is the identity.
 */
const filterExchanges = (
  exchanges: readonly TraceExchange[],
  filters: ExchangeFilters
): readonly TraceExchange[] => {
  const needle = filters.urlQuery.trim().toLowerCase()
  return exchanges.filter((exchange) => {
    if (needle !== '' && !exchange.url.toLowerCase().includes(needle)) return false
    if (filters.statusClass !== ANY && statusClassOf(exchange.status) !== filters.statusClass) {
      return false
    }
    return (
      filters.contentType === ANY ||
      normalizeContentType(exchange.body.contentType) === filters.contentType
    )
  })
}

export {
  ANY,
  contentTypeOptions,
  type ExchangeFilters,
  filterExchanges,
  NO_FILTERS,
  normalizeContentType,
  STATUS_CLASSES,
  type StatusClass,
  statusClassOf,
}
