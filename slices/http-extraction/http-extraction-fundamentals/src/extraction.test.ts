import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as Extraction from './extraction.ts'
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
    // The Pick constraint keeps a concrete element's own fields on the way out —
    // the same trick the live tracker uses to keep `followUpSteps`.
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
