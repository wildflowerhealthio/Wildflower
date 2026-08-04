import { joinIdComponents } from 'fhir-r4/identity'
import type { TraceExchange } from 'web-trace-core'

/**
 * A cheap, stable key for one exchange, for React lists and selection state.
 *
 * @param exchange - The exchange to key
 * @returns The `(sessionId, requestId)` pair, unambiguously encoded
 *
 * @remarks
 * **Not the FHIR resource id, and deliberately so.** `traceResourceId` renders
 * the same pair through two 64-bit hash lanes — right at a write or a decode,
 * wrong in a render body, where it cost ~24 ms per keystroke over a
 * thousand-exchange session. Neither caller needs the resource id: a React `key`
 * and panel-local selection state want identity within one rendered list, which
 * the pair already is. See this package's AGENTS.md.
 *
 * `joinIdComponents` rather than a `-` join because both halves are arbitrary
 * non-empty strings, so `('s-req', '77')` and `('s', 'req-77')` would otherwise
 * be one key and a selection would open the wrong row.
 */
const exchangeKey = (exchange: Pick<TraceExchange, 'sessionId' | 'requestId'>): string =>
  joinIdComponents([exchange.sessionId, exchange.requestId])

export { exchangeKey }
