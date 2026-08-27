import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it, test } from 'vite-plus/test'

import { arbitraryScenarios, type Scenario } from './extraction.test-helpers.ts'
import * as Extraction from './extraction.ts'
import * as HttpResponseKind from './http-response-kind.ts'
import { Specificity } from './specificity.ts'
import { echoResponseKind, makeExtractionInput, POISON_BODY, type Echo } from './test-helpers.ts'

const AlphaEntity = echoResponseKind('AlphaEntity', 'alpha')
const BetaEntity = echoResponseKind('BetaEntity', 'beta')
const responseKinds = [AlphaEntity, BetaEntity]

const extract = (scenarios: readonly Scenario[]): Extraction.Extraction<Echo> =>
  Effect.runSync(
    Extraction.run(
      responseKinds,
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

  test('property: the highest-specificity entity that claims wins, regardless of list order', () => {
    // A broad entity and a narrower one both claim the same URL, with distinct
    // specificities: the more specific wins wherever it sits in the list — the
    // change from the old first-match-wins routing.
    const Broad = echoResponseKind('BroadEntity', 'alpha', Specificity.PROTOCOL)
    const Narrow = echoResponseKind('NarrowEntity', 'alpha', Specificity.PORTAL)

    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.boolean(), (path, broadFirst) => {
        const url = `https://example.com/alpha/${encodeURIComponent(path)}`
        const order = broadFirst ? [Broad, Narrow] : [Narrow, Broad]

        const extraction = Effect.runSync(
          Extraction.run(order, [makeExtractionInput({ id: 'r1', url, body: '{}' })])
        )

        expect(extraction.batches).toHaveLength(1)
        // Narrow (PORTAL) always wins over Broad (PROTOCOL), whatever the order.
        expect(extraction.batches[0].entityName).toBe('NarrowEntity')
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
      Extraction.run(responseKinds, [
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
    const Counting: HttpResponseKind.HttpResponseKind<Echo> = HttpResponseKind.make({
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
    expect(Effect.runSync(Extraction.run(responseKinds, []))).toEqual({
      batches: [],
      unmatched: [],
      parseFailures: [],
      bodyAbsent: [],
    })
  })
})

describe('Extraction.routeTo', () => {
  const Broad = echoResponseKind('BroadEntity', 'alpha', Specificity.PROTOCOL)
  const Narrow = echoResponseKind('NarrowEntity', 'alpha', Specificity.PORTAL)

  it('picks the highest-specificity claimant', () => {
    const routed = Extraction.routeTo([Broad, Narrow], 'https://example.com/alpha/1')
    expect(Option.map(routed, (r) => r.kind.name)).toEqual(Option.some('NarrowEntity'))
    expect(Option.map(routed, (r) => r.recognized.specificity)).toEqual(
      Option.some(Specificity.PORTAL)
    )
  })

  it('breaks ties toward the earliest candidate in list order', () => {
    const first = echoResponseKind('FirstEntity', 'alpha', Specificity.PROTOCOL)
    const second = echoResponseKind('SecondEntity', 'alpha', Specificity.PROTOCOL)
    expect(
      Option.map(Extraction.routeTo([first, second], 'https://x/alpha/1'), (r) => r.kind.name)
    ).toEqual(Option.some('FirstEntity'))
    expect(
      Option.map(Extraction.routeTo([second, first], 'https://x/alpha/1'), (r) => r.kind.name)
    ).toEqual(Option.some('SecondEntity'))
  })

  it('is None when nothing claims', () => {
    expect(Extraction.routeTo([Broad, Narrow], 'https://example.com/gamma/1')).toEqual(
      Option.none()
    )
  })

  it("carries a caller's extra element fields through untouched", () => {
    // The Pick constraint keeps a concrete element's own fields on the way out —
    // the same trick the live tracker uses to keep `followUpSteps`.
    const withExtra = { ...Narrow, followUpMarker: 'ride-along' }
    const routed = Extraction.routeTo([withExtra], 'https://x/alpha/1')
    expect(Option.map(routed, (r) => r.kind.followUpMarker)).toEqual(Option.some('ride-along'))
  })
})

describe('Extraction.recognize', () => {
  const Broad = echoResponseKind('BroadEntity', 'alpha', Specificity.PROTOCOL)
  const Narrow = echoResponseKind('NarrowEntity', 'alpha', Specificity.PORTAL)

  it('returns every claiming kind, sorted by specificity descending', () => {
    const [recognized] = Extraction.recognize(
      [Broad, Narrow],
      [makeExtractionInput({ id: 'r1', url: 'https://x/alpha/1' })]
    )
    expect(recognized?.candidates.map((c) => c.kind.name)).toEqual(['NarrowEntity', 'BroadEntity'])
  })

  it('keeps list order for equal specificities', () => {
    const first = echoResponseKind('FirstEntity', 'alpha', Specificity.PROTOCOL)
    const second = echoResponseKind('SecondEntity', 'alpha', Specificity.PROTOCOL)
    const [recognized] = Extraction.recognize(
      [first, second],
      [makeExtractionInput({ id: 'r1', url: 'https://x/alpha/1' })]
    )
    expect(recognized?.candidates.map((c) => c.kind.name)).toEqual(['FirstEntity', 'SecondEntity'])
  })

  it('is an empty candidate list for a response no kind claims', () => {
    const [recognized] = Extraction.recognize(
      [Broad, Narrow],
      [makeExtractionInput({ id: 'r1', url: 'https://x/gamma/1' })]
    )
    expect(recognized?.candidates).toEqual([])
    expect(recognized?.ref).toEqual({ id: 'r1', url: 'https://x/gamma/1' })
  })
})

describe('Extraction.parseWith', () => {
  const alpha = echoResponseKind('AlphaEntity', 'alpha')

  it('yields a resources outcome for a body that decodes', () => {
    const outcome = Effect.runSync(
      Extraction.parseWith(alpha, makeExtractionInput({ url: 'https://x/alpha/1', body: '{}' }))
    )
    expect(outcome._tag).toBe('resources')
    if (outcome._tag !== 'resources') throw new Error('expected resources')
    expect(outcome.resources).toHaveLength(1)
  })

  it('yields a parseError outcome for a body that fails to decode', () => {
    const outcome = Effect.runSync(
      Extraction.parseWith(
        alpha,
        makeExtractionInput({ url: 'https://x/alpha/1', body: POISON_BODY })
      )
    )
    expect(outcome._tag).toBe('parseError')
  })

  it('yields a bodyAbsent outcome without calling parse', () => {
    let parseCalls = 0
    const counting = {
      ...alpha,
      parse: (r: Parameters<typeof alpha.parse>[0]) => {
        parseCalls += 1
        return alpha.parse(r)
      },
    }
    const outcome = Effect.runSync(
      Extraction.parseWith(
        counting,
        makeExtractionInput({ url: 'https://x/alpha/1', bodyAbsent: true })
      )
    )
    expect(outcome._tag).toBe('bodyAbsent')
    expect(parseCalls).toBe(0)
  })
})
