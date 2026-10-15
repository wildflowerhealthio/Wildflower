import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Option } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as Extraction from './extraction.ts'
import { HTTP_METHODS } from './http-method.ts'
import { Specificity } from './specificity.ts'
import { echoResponseKind, makeExtractionInput, POISON_BODY } from './test-helpers.ts'

describe('Extraction.routeTo', () => {
  const Broad = echoResponseKind('BroadEntity', 'alpha', Specificity.PROTOCOL)
  const Narrow = echoResponseKind('NarrowEntity', 'alpha', Specificity.PORTAL)

  it('picks the highest-specificity claimant', () => {
    const routed = Extraction.routeTo(
      [Broad, Narrow],
      'https://example.com/alpha/1',
      Option.some('GET')
    )
    expect(Option.map(routed, (r) => r.kind.name)).toEqual(Option.some('NarrowEntity'))
    expect(Option.map(routed, (r) => r.recognized.specificity)).toEqual(
      Option.some(Specificity.PORTAL)
    )
  })

  it('breaks ties toward the earliest candidate in list order', () => {
    const first = echoResponseKind('FirstEntity', 'alpha', Specificity.PROTOCOL)
    const second = echoResponseKind('SecondEntity', 'alpha', Specificity.PROTOCOL)
    expect(
      Option.map(
        Extraction.routeTo([first, second], 'https://x/alpha/1', Option.some('GET')),
        (r) => r.kind.name
      )
    ).toEqual(Option.some('FirstEntity'))
    expect(
      Option.map(
        Extraction.routeTo([second, first], 'https://x/alpha/1', Option.some('GET')),
        (r) => r.kind.name
      )
    ).toEqual(Option.some('SecondEntity'))
  })

  it('is None when nothing claims', () => {
    expect(
      Extraction.routeTo([Broad, Narrow], 'https://example.com/gamma/1', Option.some('GET'))
    ).toEqual(Option.none())
  })

  it("carries a caller's extra element fields through untouched", () => {
    // The Pick constraint keeps a concrete element's own fields on the way out,
    // so a consumer's extended kind type survives routing.
    const withExtra = { ...Narrow, followUpMarker: 'ride-along' }
    const routed = Extraction.routeTo([withExtra], 'https://x/alpha/1', Option.some('GET'))
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

describe('Extraction.findDuplicates', () => {
  it('maps a repeated (url, method, body) to the first occurrence', () => {
    const duplicates = Extraction.findDuplicates([
      makeExtractionInput({ id: 'r1', url: 'https://x/alpha/1', body: '{}' }),
      makeExtractionInput({ id: 'r2', url: 'https://x/alpha/1', body: '{}' }),
    ])
    expect([...duplicates]).toEqual([['r2', { id: 'r1', url: 'https://x/alpha/1' }]])
  })

  it('keeps the same url and body under different methods apart', () => {
    const duplicates = Extraction.findDuplicates([
      makeExtractionInput({ id: 'r1', method: Option.some('GET'), body: '{}' }),
      makeExtractionInput({ id: 'r2', method: Option.some('POST'), body: '{}' }),
      makeExtractionInput({ id: 'r3', method: Option.none(), body: '{}' }),
    ])
    expect(duplicates.size).toBe(0)
  })

  it('never pairs two bodyAbsent inputs, even with equal url, method, and body', () => {
    const duplicates = Extraction.findDuplicates([
      makeExtractionInput({ id: 'r1', bodyAbsent: true, body: '{}' }),
      makeExtractionInput({ id: 'r2', bodyAbsent: true, body: '{}' }),
    ])
    expect(duplicates.size).toBe(0)
  })

  /**
   * One string field: mostly characters from a tiny alphabet that includes
   * NUL (so a NUL lands at a field boundary often enough to catch a key whose
   * separators can be forged), with arbitrary code units mixed in.
   */
  const fieldArb = fc.string({
    unit: fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom('\u0000', 'a') },
      { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) }
    ),
    maxLength: 3,
  })

  /**
   * Inputs whose url and body are both drawn from one small pool of
   * {@link fieldArb} strings, so equal triples are common and a value can
   * move between fields (a forged separator's collision shape). Ids are the
   * input index, so they are unique.
   */
  const inputsArb = fc
    .uniqueArray(fieldArb, { minLength: 1, maxLength: 4 })
    .chain((pool) =>
      fc.array(
        fc.record({
          url: fc.constantFrom(...pool),
          body: fc.constantFrom(...pool),
          method: fc.option(fc.constantFrom(...HTTP_METHODS.slice(0, 2)), { nil: undefined }),
          bodyAbsent: fc.constantFrom(false, false, false, true),
        }),
        { maxLength: 12 }
      )
    )
    .map((fields) =>
      fields.map(({ url, body, method, bodyAbsent }, index) => ({
        input: makeExtractionInput({
          id: `r${index}`,
          url,
          body,
          method: Option.fromNullable(method),
          bodyAbsent,
        }),
        url,
        body,
        method: method ?? 'absent',
        bodyAbsent,
      }))
    )

  const sameTriple = (
    a: { url: string; body: string; method: string },
    b: { url: string; body: string; method: string }
  ): boolean => a.url === b.url && a.body === b.body && a.method === b.method

  it('maps every duplicate to the first earlier input with an equal triple, and only those', () => {
    fc.assert(
      fc.property(inputsArb, (drawn) => {
        const duplicates = Extraction.findDuplicates(drawn.map((d) => d.input))
        drawn.forEach((current, index) => {
          const first = current.bodyAbsent
            ? undefined
            : drawn
                .slice(0, index)
                .find((earlier) => !earlier.bodyAbsent && sameTriple(earlier, current))
          expect(duplicates.get(current.input.id)).toEqual(
            first === undefined ? undefined : { id: first.input.id, url: first.url }
          )
        })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('never reports a bodyAbsent input, as duplicate or as first occurrence', () => {
    fc.assert(
      fc.property(inputsArb, (drawn) => {
        const absentIds = new Set(drawn.filter((d) => d.bodyAbsent).map((d) => d.input.id))
        for (const [id, first] of Extraction.findDuplicates(drawn.map((d) => d.input))) {
          expect(absentIds.has(id)).toBe(false)
          expect(absentIds.has(first.id)).toBe(false)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('never pairs inputs that differ in url, method, or body', () => {
    fc.assert(
      fc.property(inputsArb, (drawn) => {
        const byId = new Map(drawn.map((d) => [d.input.id, d]))
        for (const [id, first] of Extraction.findDuplicates(drawn.map((d) => d.input))) {
          const dup = byId.get(id)
          const orig = byId.get(first.id)
          expect(dup !== undefined && orig !== undefined && sameTriple(dup, orig)).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
