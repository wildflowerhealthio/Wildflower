// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest's asymmetric matchers (`expect.stringContaining`) are typed `any`; the lint fires on the idiomatic log assertion below

import { Effect } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it, test } from 'vite-plus/test'

import * as EntityDefinition from '../model/entity-definition.ts'
import {
  arbitraryScenarios,
  echoEntity,
  POISON_BODY,
  replayResponse,
  type Echo,
  type Scenario,
} from './replay-entities.test-helpers.ts'
import { replayEntities, type ReplayOutcome } from './replay-entities.ts'

const AlphaEntity = echoEntity('AlphaEntity', 'alpha')
const BetaEntity = echoEntity('BetaEntity', 'beta')
const entityDefinitions = [AlphaEntity, BetaEntity]

const replay = (scenarios: readonly Scenario[]): ReplayOutcome<Echo> =>
  Effect.runSync(
    replayEntities(
      entityDefinitions,
      scenarios.map((scenario) => scenario.response)
    )
  )

/** The ids the input expected in a given bucket, in input order. */
const expectedIds = (
  scenarios: readonly Scenario[],
  predicate: (s: Scenario) => boolean
): readonly string[] => scenarios.filter(predicate).map((scenario) => scenario.response.id)

describe('replayEntities', () => {
  test('property: every response lands in exactly one bucket, in input order', () => {
    fc.assert(
      fc.property(arbitraryScenarios, (scenarios) => {
        const outcome = replay(scenarios)

        expect(outcome.batches.map((batch) => batch.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'alpha' || s.outcome === 'beta')
        )
        expect(outcome.parseFailures.map((failure) => failure.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'parseFailure')
        )
        expect(outcome.unmatched.map((ref) => ref.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'unmatched')
        )
        expect(outcome.bodyAbsent.map((ref) => ref.id)).toEqual(
          expectedIds(scenarios, (s) => s.outcome === 'bodyAbsent')
        )

        // MECE: the four buckets partition the input — no response is dropped,
        // none is reported twice.
        const reported = [
          ...outcome.batches,
          ...outcome.parseFailures,
          ...outcome.unmatched,
          ...outcome.bodyAbsent,
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
        const outcome = replay(scenarios)
        const sourceById = new Map(
          scenarios.map((scenario) => [scenario.response.id, scenario.response])
        )

        for (const batch of outcome.batches) {
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
    // the same silent ordering dependency the live tracker has.
    const Broad = echoEntity('BroadEntity', 'alpha')
    const Narrow: EntityDefinition.EntityDefinition<Echo> = EntityDefinition.make({
      ...echoEntity('NarrowEntity', 'alpha'),
      isFoundAt: (url) => url.includes('/alpha/') && url.endsWith('9'),
    })

    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.boolean(), (path, broadFirst) => {
        const url = `https://example.com/alpha/${encodeURIComponent(path)}9`
        const order = broadFirst ? [Broad, Narrow] : [Narrow, Broad]

        const outcome = Effect.runSync(
          replayEntities(order, [replayResponse({ id: 'r1', url, body: '{}' })])
        )

        expect(outcome.batches).toHaveLength(1)
        expect(outcome.batches[0].entityName).toBe(broadFirst ? 'BroadEntity' : 'NarrowEntity')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: one failing parse never disturbs the responses around it', () => {
    fc.assert(
      fc.property(arbitraryScenarios, (scenarios) => {
        const clean = scenarios.filter((scenario) => scenario.outcome !== 'parseFailure')

        // Replaying the input with every poisoned response removed produces
        // exactly the batches the full replay produced — so a failure costs
        // its own response and nothing else.
        expect(replay(scenarios).batches).toEqual(replay(clean).batches)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('reports a parse failure with the URL and the entity that claimed it', () => {
    const outcome = Effect.runSync(
      replayEntities(entityDefinitions, [
        replayResponse({ id: 'r1', url: 'https://example.com/alpha/1', body: POISON_BODY }),
      ])
    )

    expect(outcome.batches).toEqual([])
    expect(outcome.parseFailures).toHaveLength(1)
    expect(outcome.parseFailures[0]).toEqual(
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

    const outcome = Effect.runSync(
      replayEntities(
        [Counting],
        [
          replayResponse({ id: 'r1', url: 'https://example.com/alpha/1', bodyAbsent: true }),
          // A genuinely empty body is *not* an absent one: it decodes.
          replayResponse({ id: 'r2', url: 'https://example.com/alpha/2', body: new Uint8Array() }),
        ]
      )
    )

    expect(parseCalls).toBe(1)
    expect(outcome.bodyAbsent).toEqual([
      { id: 'r1', url: 'https://example.com/alpha/1', entityName: 'AlphaEntity' },
    ])
    expect(outcome.batches.map((batch) => batch.id)).toEqual(['r2'])
    expect(outcome.batches[0].resources[0].bytes).toEqual(new Uint8Array())
  })

  it('WARNs once for the entities declaring followUpSteps, and never generates', () => {
    const Generating: EntityDefinition.EntityDefinition<Echo> = EntityDefinition.make({
      ...AlphaEntity,
      followUpSteps: () => {
        throw new Error('followUpSteps must not run offline')
      },
    })

    return Effect.runPromise(
      replayEntities(
        [Generating],
        [
          replayResponse({ id: 'r1', url: 'https://example.com/alpha/1', body: '{}' }),
          replayResponse({ id: 'r2', url: 'https://example.com/alpha/2', body: '{}' }),
        ]
      ).pipe(
        Effect.tap((outcome) => Effect.sync(() => expect(outcome.batches).toHaveLength(2))),
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            expect.objectContaining({
              level: 'WARN',
              message: expect.stringContaining('ignoring followUpSteps declared by AlphaEntity'),
            }),
          ])
        }),
        Effect.scoped
      )
    )
  })

  it('logs nothing when no entity declares followUpSteps', () =>
    Effect.runPromise(
      replayEntities(entityDefinitions, [
        replayResponse({ id: 'r1', url: 'https://example.com/alpha/1', body: '{}' }),
      ]).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([])
        }),
        Effect.scoped
      )
    ))

  it('returns empty accounting for an empty input', () => {
    expect(Effect.runSync(replayEntities(entityDefinitions, []))).toEqual({
      batches: [],
      unmatched: [],
      parseFailures: [],
      bodyAbsent: [],
    })
  })
})
