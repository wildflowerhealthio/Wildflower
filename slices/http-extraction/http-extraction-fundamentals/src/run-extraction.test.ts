import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it, test } from 'vite-plus/test'

import { arbitraryScenarios, type Scenario } from './extraction.test-helpers.ts'
import * as HttpResponseKind from './http-response-kind.ts'
import { type ExtractionResult, runExtraction } from './run-extraction.ts'
import { Specificity } from './specificity.ts'
import { echoResponseKind, makeExtractionInput, POISON_BODY, type Echo } from './test-helpers.ts'

const AlphaEntity = echoResponseKind('AlphaEntity', 'alpha')
const BetaEntity = echoResponseKind('BetaEntity', 'beta')
const responseKinds = [AlphaEntity, BetaEntity]

const extract = (scenarios: readonly Scenario[]): ExtractionResult<Echo> =>
  Effect.runSync(
    runExtraction(
      responseKinds,
      scenarios.map((scenario) => scenario.response)
    )
  )

/** The ids the input expected in a given bucket, in input order. */
const expectedIds = (
  scenarios: readonly Scenario[],
  predicate: (s: Scenario) => boolean
): readonly string[] => scenarios.filter(predicate).map((scenario) => scenario.response.id)

describe('runExtraction', () => {
  test('property: every response lands in exactly one bucket, in input order', () => {
    fc.assert(
      fc.property(arbitraryScenarios, (scenarios) => {
        const extraction = extract(scenarios)

        expect(extraction.batches.map((batch) => batch.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'alpha' || s.outcome === 'beta')
        )
        expect(extraction.parseFailures.map((failure) => failure.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'parseFailure')
        )
        expect(extraction.unmatched.map((ref) => ref.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'unmatched')
        )
        expect(extraction.bodyAbsent.map((ref) => ref.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'bodyAbsent')
        )

        // MECE: the four buckets partition the input — no response is dropped,
        // none is reported twice.
        const reported = [
          ...extraction.batches,
          ...extraction.parseFailures,
          ...extraction.unmatched,
          ...extraction.bodyAbsent,
        ].map((entry) => entry.id)
        expect(new Set(reported).size).toBe(reported.length)
        expect(reported.toSorted()).toEqual(
          scenarios.map((scenario) => scenario.response.id).toSorted()
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: a matched response reaches parse with its fields and bytes intact', () => {
    fc.assert(
      fc.property(arbitraryScenarios, (scenarios) => {
        const extraction = extract(scenarios)
        const sourceById = new Map(
          scenarios.map((scenario) => [scenario.response.id, scenario.response])
        )

        for (const batch of extraction.batches) {
          const source = sourceById.get(batch.id)
          assert(source !== undefined, 'every batch traces back to an input response')
          expect(batch.url).toBe(source.url)
          expect(batch.resources).toHaveLength(1)
          const echo = batch.resources[0]
          expect(echo.responseKindName).toBe(batch.responseKindName)
          expect(echo.id).toBe(source.id)
          expect(echo.url).toBe(source.url)
          expect(echo.status).toBe(source.status)
          expect(echo.statusText).toBe(source.statusText)
          expect(echo.headers).toEqual(source.headers)
          // Byte-for-byte, including bodies that are not valid UTF-8.
          expect([...echo.bytes]).toEqual([...source.body])
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: the highest-specificity kind that claims wins, regardless of list order', () => {
    // A broad kind and a narrower one both claim the same URL, with distinct
    // specificities: the more specific wins wherever it sits in the list — the
    // change from the old first-match-wins routing.
    const Broad = echoResponseKind('BroadEntity', 'alpha', Specificity.PROTOCOL)
    const Narrow = echoResponseKind('NarrowEntity', 'alpha', Specificity.PORTAL)

    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.boolean(), (path, broadFirst) => {
        const url = `https://example.com/alpha/${encodeURIComponent(path)}`
        const order = broadFirst ? [Broad, Narrow] : [Narrow, Broad]

        const extraction = Effect.runSync(
          runExtraction(order, [makeExtractionInput({ id: 'r1', url, body: '{}' })])
        )

        expect(extraction.batches).toHaveLength(1)
        // Narrow (PORTAL) always wins over Broad (PROTOCOL), whatever the order.
        expect(extraction.batches[0].responseKindName).toBe('NarrowEntity')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: one failing parse never disturbs the responses around it', () => {
    fc.assert(
      fc.property(arbitraryScenarios, (scenarios) => {
        const clean = scenarios.filter((scenario) => scenario.outcome !== 'parseFailure')

        // Extracting the input with every poisoned response removed produces
        // exactly the batches the full extraction produced — so a failure
        // costs its own response and nothing else.
        expect(extract(scenarios).batches).toEqual(extract(clean).batches)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('reports a parse failure with the URL and the kind that claimed it', () => {
    const extraction = Effect.runSync(
      runExtraction(responseKinds, [
        makeExtractionInput({ id: 'r1', url: 'https://example.com/alpha/1', body: POISON_BODY }),
      ])
    )

    expect(extraction.batches).toEqual([])
    expect(extraction.parseFailures).toHaveLength(1)
    expect(extraction.parseFailures[0]).toEqual(
      expect.objectContaining({
        id: 'r1',
        url: 'https://example.com/alpha/1',
        responseKindName: 'AlphaEntity',
      })
    )
  })

  it('never calls parse for a response the archive carried no body for', () => {
    let parseCalls = 0
    const Counting: HttpResponseKind.HttpResponseKind<Echo> = HttpResponseKind.make({
      ...AlphaEntity,
      parse: (response) => {
        parseCalls += 1
        return AlphaEntity.parse(response)
      },
    })

    const extraction = Effect.runSync(
      runExtraction(
        [Counting],
        [
          makeExtractionInput({ id: 'r1', url: 'https://example.com/alpha/1', bodyAbsent: true }),
          // A genuinely empty body is *not* an absent one: it decodes.
          makeExtractionInput({
            id: 'r2',
            url: 'https://example.com/alpha/2',
            body: new Uint8Array(),
          }),
        ]
      )
    )

    expect(parseCalls).toBe(1)
    expect(extraction.bodyAbsent).toEqual([
      { id: 'r1', url: 'https://example.com/alpha/1', responseKindName: 'AlphaEntity' },
    ])
    expect(extraction.batches.map((batch) => batch.id)).toEqual(['r2'])
    expect(extraction.batches[0].resources[0].bytes).toEqual(new Uint8Array())
  })

  it('returns empty accounting for an empty input', () => {
    expect(Effect.runSync(runExtraction(responseKinds, []))).toEqual({
      batches: [],
      unmatched: [],
      parseFailures: [],
      bodyAbsent: [],
    })
  })
})
