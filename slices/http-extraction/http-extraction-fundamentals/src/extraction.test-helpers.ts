import * as fc from 'fast-check'

import type * as Extraction from './extraction.ts'
import { makeExtractionInput, POISON_BODY } from './test-helpers.ts'

const utf8 = new TextEncoder()

/**
 * The outcome a generated response is expected to land in — the property's
 * oracle, chosen by the arbitrary rather than derived from the runner.
 */
type ExpectedOutcome = 'alpha' | 'beta' | 'parseFailure' | 'unmatched' | 'bodyAbsent'

/** A generated response paired with the bucket it must end up in. */
interface Scenario {
  readonly outcome: ExpectedOutcome
  readonly response: Extraction.Input
}

/**
 * The URL marker segment each outcome needs: `gamma` is claimed by no entity,
 * `beta` by the second one, and everything that must reach the first entity's
 * `parse` (or be stopped just before it) uses `alpha`.
 */
const MARKER_FOR_OUTCOME: Record<ExpectedOutcome, string> = {
  alpha: 'alpha',
  beta: 'beta',
  parseFailure: 'alpha',
  unmatched: 'gamma',
  bodyAbsent: 'alpha',
}

const arbitraryHeaders: fc.Arbitrary<readonly (readonly [string, string])[]> = fc.array(
  fc.tuple(fc.string({ minLength: 1 }), fc.string()).map(([name, value]) => [name, value] as const),
  { maxLength: 3 }
)

/**
 * Generate one response together with the bucket it belongs in: a marker
 * segment picks the claiming entity (or none), and `POISON`/`bodyAbsent` pick
 * the two non-decoding outcomes.
 */
const arbitraryScenario = (index: number): fc.Arbitrary<Scenario> =>
  fc
    .record({
      outcome: fc.constantFrom<ExpectedOutcome>(
        'alpha',
        'beta',
        'parseFailure',
        'unmatched',
        'bodyAbsent'
      ),
      path: fc.string({ minLength: 1 }),
      status: fc.integer({ min: 100, max: 599 }),
      statusText: fc.string(),
      headers: arbitraryHeaders,
      // Arbitrary bytes, not text: a body that is not valid UTF-8 must still
      // reach `parse` byte-for-byte — and never the poison body, which would
      // flip a scenario's oracle.
      body: fc
        .uint8Array({ maxLength: 64 })
        .filter((bytes) => new TextDecoder().decode(bytes) !== POISON_BODY),
    })
    .map(({ outcome, path, status, statusText, headers, body }): Scenario => {
      const marker = MARKER_FOR_OUTCOME[outcome]
      return {
        outcome,
        // The scenario index in the URL keeps every response's `(url, method,
        // body)` unique across a run, so the `duplicate` bucket stays empty
        // in these property tests — the oracle is per-scenario and doesn't
        // model an alternate landing spot.
        response: makeExtractionInput({
          id: `req-${index}`,
          url: `https://example.com/${marker}/${index}/${encodeURIComponent(path)}`,
          status,
          statusText,
          headers,
          body: outcome === 'parseFailure' ? utf8.encode(POISON_BODY) : body,
          bodyAbsent: outcome === 'bodyAbsent',
        }),
      }
    })

/** A whole extraction input: a list of scenarios, each carrying its own oracle. */
const arbitraryScenarios: fc.Arbitrary<readonly Scenario[]> = fc
  .nat({ max: 12 })
  .chain((length) =>
    fc.tuple(...Array.from({ length }, (_unused, index) => arbitraryScenario(index)))
  )

export { arbitraryScenario, arbitraryScenarios }
export type { ExpectedOutcome, Scenario }
