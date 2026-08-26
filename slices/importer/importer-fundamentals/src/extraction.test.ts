import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it, test } from 'vite-plus/test'

import * as EntityDefinition from './entity-definition.ts'
import { arbitraryScenarios, type Scenario } from './extraction.test-helpers.ts'
import * as Extraction from './extraction.ts'
import { echoEntity, makeExtractionInput, POISON_BODY, type Echo } from './test-helpers.ts'

const AlphaEntity = echoEntity('AlphaEntity', 'alpha')
const BetaEntity = echoEntity('BetaEntity', 'beta')
const entityDefinitions = [AlphaEntity, BetaEntity]

const extract = (scenarios: readonly Scenario[]): Extraction.Extraction<Echo> =>
  Effect.runSync(
    Extraction.run(
      entityDefinitions,
      scenarios.map((scenario) => scenario.response)
    )
  )

/** The ids the input expected in a given bucket, in input order. */
const expectedIds = (
  scenarios: readonly Scenario[],
  predicate: (s: Scenario) => boolean
): readonly string[] => scenarios.filter(predicate).map((scenario) => scenario.response.id)

describe('Extraction.run', () => {
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
          expect(echo.entityName).toBe(batch.entityName)
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

  test('property: the first entity whose isFoundAt matches claims the response', () => {
    // A pattern that claims everything, and one that claims a subset of it:
    // whichever comes first in the list wins every response they both match —
    // the same silent ordering dependency every consumer of an entity list has.
    const Broad = echoEntity('BroadEntity', 'alpha')
    const Narrow: EntityDefinition.EntityDefinition<Echo> = EntityDefinition.make({
      ...echoEntity('NarrowEntity', 'alpha'),
      isFoundAt: (url) => url.includes('/alpha/') && url.endsWith('9'),
    })

    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.boolean(), (path, broadFirst) => {
        const url = `https://example.com/alpha/${encodeURIComponent(path)}9`
        const order = broadFirst ? [Broad, Narrow] : [Narrow, Broad]

        const extraction = Effect.runSync(
          Extraction.run(order, [makeExtractionInput({ id: 'r1', url, body: '{}' })])
        )

        expect(extraction.batches).toHaveLength(1)
        expect(extraction.batches[0].entityName).toBe(broadFirst ? 'BroadEntity' : 'NarrowEntity')
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

  it('reports a parse failure with the URL and the entity that claimed it', () => {
    const extraction = Effect.runSync(
      Extraction.run(entityDefinitions, [
        makeExtractionInput({ id: 'r1', url: 'https://example.com/alpha/1', body: POISON_BODY }),
      ])
    )

    expect(extraction.batches).toEqual([])
    expect(extraction.parseFailures).toHaveLength(1)
    expect(extraction.parseFailures[0]).toEqual(
      expect.objectContaining({
        id: 'r1',
        url: 'https://example.com/alpha/1',
        entityName: 'AlphaEntity',
      })
    )
  })

  it('never calls parse for a response the archive carried no body for', () => {
    let parseCalls = 0
    const Counting: EntityDefinition.EntityDefinition<Echo> = EntityDefinition.make({
      ...AlphaEntity,
      parse: (response) => {
        parseCalls += 1
        return AlphaEntity.parse(response)
      },
    })

    const extraction = Effect.runSync(
      Extraction.run(
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
      { id: 'r1', url: 'https://example.com/alpha/1', entityName: 'AlphaEntity' },
    ])
    expect(extraction.batches.map((batch) => batch.id)).toEqual(['r2'])
    expect(extraction.batches[0].resources[0].bytes).toEqual(new Uint8Array())
  })

  it('returns empty accounting for an empty input', () => {
    expect(Effect.runSync(Extraction.run(entityDefinitions, []))).toEqual({
      batches: [],
      unmatched: [],
      parseFailures: [],
      bodyAbsent: [],
    })
  })
})
