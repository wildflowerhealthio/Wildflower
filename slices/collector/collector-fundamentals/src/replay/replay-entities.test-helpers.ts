import { DateTime, Effect, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'

import * as EntityDefinition from '../model/entity-definition.ts'
import type { ReplayResponse } from './replay-entities.ts'

/**
 * What the test entities decode to: the response fields they were handed,
 * echoed back.
 *
 * @remarks
 * Echoing rather than decoding a payload is what lets a property assert
 * *provenance* — that this batch came from that response, and that the bytes
 * `parse` saw are the bytes the input carried — without the test knowing what
 * the generated body was.
 */
interface Echo {
  readonly entityName: string
  readonly id: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: readonly (readonly [string, string])[]
  readonly bytes: Uint8Array
}

/**
 * An entity claiming every URL containing `/<marker>/`, decoding to a single
 * {@link Echo} — unless the body is the literal `POISON`, which fails the
 * parse.
 *
 * @remarks
 * The poison body is how a property makes a *specific* response fail without
 * changing which entity claims it, so parse-failure isolation is testable
 * against an otherwise identical fold.
 */
const echoEntity = (name: string, marker: string): EntityDefinition.EntityDefinition<Echo> =>
  EntityDefinition.make({
    name,
    isFoundAt: (url) => url.includes(`/${marker}/`),
    parse: (response) =>
      response.text() === POISON_BODY
        ? Effect.fail(
            new ParseResult.ParseError({
              issue: new ParseResult.Type(Schema.String.ast, response.url, 'poisoned body'),
            })
          )
        : Effect.succeed([
            {
              entityName: name,
              id: response.id,
              url: response.url,
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              bytes: response.bytes(),
            },
          ]),
  })

/** The body an {@link echoEntity} refuses to parse. */
const POISON_BODY = 'POISON'

/** Fixed instant, so a generated response never depends on the clock. */
const REPLAY_STARTED_AT = DateTime.unsafeMake('2026-02-02T00:00:00.000Z')

const utf8 = new TextEncoder()

/** Build a {@link ReplayResponse}, defaulting everything a test doesn't set. */
const replayResponse = (
  overrides: Partial<Omit<ReplayResponse, 'body'>> & { readonly body?: string | Uint8Array } = {}
): ReplayResponse => ({
  id: overrides.id ?? 'req-1',
  url: overrides.url ?? 'https://example.com/alpha/1',
  status: overrides.status ?? 200,
  statusText: overrides.statusText ?? 'OK',
  headers: overrides.headers ?? [['content-type', 'application/json']],
  startedAt: overrides.startedAt ?? REPLAY_STARTED_AT,
  body:
    typeof overrides.body === 'string'
      ? utf8.encode(overrides.body)
      : (overrides.body ?? utf8.encode('{}')),
  bodyAbsent: overrides.bodyAbsent ?? false,
})

/**
 * The outcome a generated response is expected to land in — the property's
 * oracle, chosen by the arbitrary rather than derived from the runner.
 */
type ExpectedOutcome = 'alpha' | 'beta' | 'parseFailure' | 'unmatched' | 'bodyAbsent'

/** A generated response paired with the bucket it must end up in. */
interface Scenario {
  readonly outcome: ExpectedOutcome
  readonly response: ReplayResponse
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
        response: replayResponse({
          id: `req-${index}`,
          url: `https://example.com/${marker}/${encodeURIComponent(path)}`,
          status,
          statusText,
          headers,
          body: outcome === 'parseFailure' ? utf8.encode(POISON_BODY) : body,
          bodyAbsent: outcome === 'bodyAbsent',
        }),
      }
    })

/** A whole replay input: a list of scenarios, each carrying its own oracle. */
const arbitraryScenarios: fc.Arbitrary<readonly Scenario[]> = fc
  .nat({ max: 12 })
  .chain((length) =>
    fc.tuple(...Array.from({ length }, (_unused, index) => arbitraryScenario(index)))
  )

export {
  arbitraryScenario,
  arbitraryScenarios,
  echoEntity,
  POISON_BODY,
  REPLAY_STARTED_AT,
  replayResponse,
}
export type { Echo, ExpectedOutcome, Scenario }
