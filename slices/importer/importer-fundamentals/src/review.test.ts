import { DateTime, Effect, Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'

import type { Extraction } from 'http-extraction-fundamentals'
import { HttpResponseKind } from 'http-extraction-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as Review from './review.ts'

/**
 * The per-response, per-resource review model is pure selection state — no DOM,
 * no framework — so it is driven directly: a fixed pool of response kinds, a
 * set of inputs, and the transitions over the selection they produce. The three
 * axes are exercised apart and together: whole-import kind toggles re-derive
 * every response's pick, per-response overrides win only when they name a
 * still-enabled candidate, per-resource opt-outs drop exactly the resource they
 * key, and {@link Review.chosen} / {@link Review.preview} +
 * {@link Review.chosenResources} decode only what the selection opted into.
 */

/** A kind that claims URLs containing `token`, at `specificity`, parsing to its own name. */
const kind = (
  name: string,
  specificity: number,
  token: string
): HttpResponseKind.HttpResponseKind<string> =>
  HttpResponseKind.make({
    name,
    tryRecognize: (url) => (url.includes(token) ? Option.some({ specificity }) : Option.none()),
    parse: () => Effect.succeed([name]),
  })

/** A kind that claims URLs containing `token` and parses to a fixed list of resources. */
const kindReturning = (
  name: string,
  specificity: number,
  token: string,
  resources: readonly string[]
): HttpResponseKind.HttpResponseKind<string> =>
  HttpResponseKind.make({
    name,
    tryRecognize: (url) => (url.includes(token) ? Option.some({ specificity }) : Option.none()),
    parse: () => Effect.succeed([...resources]),
  })

/** A `patient` kind (mid specificity) and an `observation` kind (higher) — disjoint tokens. */
const patientKind = kind('patient', 50, '/Patient')
const observationKind = kind('observation', 50, '/Observation')
/** A broad `portal` kind (low specificity) that also claims `/Patient`, to force an overlap. */
const portalKind = kind('portal', 10, '/Patient')

/** One decoded response the recognizer reads. */
const input = (id: string, url: string, bodyAbsent = false): Extraction.Input => ({
  id,
  url,
  method: Option.some('GET'),
  status: 200,
  statusText: 'OK',
  headers: [],
  startedAt: DateTime.unsafeNow(),
  body: new Uint8Array(),
  bodyAbsent,
})

describe('Review.initial', () => {
  it('should enable every kind in the pool, hold no overrides, and exclude no resources', () => {
    // Arrange
    const pool = [patientKind, observationKind]

    // Act
    const selection = Review.initial(pool)

    // Assert
    expect(selection.enabledKinds).toEqual(new Set(['patient', 'observation']))
    expect(selection.overrides.size).toBe(0)
    expect(selection.excludedResources.size).toBe(0)
  })
})

describe('Review.pickFor', () => {
  it('should default to the top-specificity candidate among enabled kinds', () => {
    // Arrange — a URL both `portal` (10) and `patient` (50) claim.
    const pool = [portalKind, patientKind]
    const [recognized] = Review.recognize(pool, [input('r0', 'https://ehr.test/Patient/1')])

    // Act
    const pick = Review.pickFor(recognized, Review.initial(pool))

    // Assert — highest specificity wins, so `patient`, not the broad `portal`.
    expect(Option.getOrThrow(pick).kind.name).toBe('patient')
  })

  it('should re-pick the next candidate when the default kind is disabled', () => {
    // Arrange
    const pool = [portalKind, patientKind]
    const [recognized] = Review.recognize(pool, [input('r0', 'https://ehr.test/Patient/1')])
    const selection = Review.toggleKind(Review.initial(pool), 'patient')

    // Act
    const pick = Review.pickFor(recognized, selection)

    // Assert — with `patient` off, the overlap falls to the still-enabled `portal`.
    expect(Option.getOrThrow(pick).kind.name).toBe('portal')
  })

  it('should be None when no enabled kind claims the response', () => {
    // Arrange — only `patient` claims, and it is disabled.
    const pool = [patientKind]
    const [recognized] = Review.recognize(pool, [input('r0', 'https://ehr.test/Patient/1')])
    const selection = Review.toggleKind(Review.initial(pool), 'patient')

    // Act / Assert
    expect(Option.isNone(Review.pickFor(recognized, selection))).toBe(true)
  })

  it('should honour an override that names a still-enabled candidate', () => {
    // Arrange
    const pool = [portalKind, patientKind]
    const [recognized] = Review.recognize(pool, [input('r0', 'https://ehr.test/Patient/1')])
    const selection = Review.overridePick(Review.initial(pool), 'r0', 'portal')

    // Act
    const pick = Review.pickFor(recognized, selection)

    // Assert — the override beats the default top-specificity pick.
    expect(Option.getOrThrow(pick).kind.name).toBe('portal')
  })

  it('should fall back to the default when the override names a disabled kind', () => {
    // Arrange — override to `portal`, then disable `portal`.
    const pool = [portalKind, patientKind]
    const [recognized] = Review.recognize(pool, [input('r0', 'https://ehr.test/Patient/1')])
    const selection = Review.toggleKind(
      Review.overridePick(Review.initial(pool), 'r0', 'portal'),
      'portal'
    )

    // Act
    const pick = Review.pickFor(recognized, selection)

    // Assert
    expect(Option.getOrThrow(pick).kind.name).toBe('patient')
  })
})

describe('Review.preview', () => {
  it('should mint a stable per-resource key inside each parsed response', async () => {
    // Arrange — a kind that returns three resources for the one response
    const three = kindReturning('three', 50, '/many', ['a', 'b', 'c'])
    const responses = [input('r-many', 'https://ehr.test/many')]

    // Act
    const previews = await Effect.runPromise(
      Review.preview([three], responses, Review.initial([three]))
    )

    // Assert — every resource is keyed by its response id and its index
    expect(previews).toHaveLength(1)
    const [only] = previews
    expect(only?.outcome._tag).toBe('resources')
    if (only?.outcome._tag === 'resources') {
      expect(only.outcome.resources.map((r) => r.key)).toEqual(['r-many:0', 'r-many:1', 'r-many:2'])
    }
  })

  it('should surface a parse failure as data on its response row', async () => {
    // Arrange — a kind whose parse fails. Decoding a `null` under a number
    // schema raises a real `ParseError`, no unsafe cast needed.
    const failingSchema = Schema.transformOrFail(Schema.Unknown, Schema.Array(Schema.String), {
      strict: true,
      decode: (value, _options, ast) =>
        ParseResult.fail(new ParseResult.Type(ast, value, 'always fails')),
      encode: (value) => ParseResult.succeed(value),
    })
    const failing = HttpResponseKind.make<string>({
      name: 'failing',
      tryRecognize: (url) =>
        url.includes('/bad') ? Option.some({ specificity: 50 }) : Option.none(),
      parse: () => Schema.decodeUnknown(failingSchema)(null),
    })
    const responses = [input('r-bad', 'https://ehr.test/bad')]

    // Act
    const previews = await Effect.runPromise(
      Review.preview([failing], responses, Review.initial([failing]))
    )

    // Assert
    expect(previews).toHaveLength(1)
    expect(previews[0]?.outcome._tag).toBe('parseError')
  })

  it('should carry a stable key across every response in a batch', async () => {
    // Arrange — a batch with two responses producing three resources each
    const three = kindReturning('three', 50, '/many', ['a', 'b', 'c'])
    const responses = [
      input('r-1', 'https://ehr.test/many/1'),
      input('r-2', 'https://ehr.test/many/2'),
    ]

    // Act
    const previews = await Effect.runPromise(
      Review.preview([three], responses, Review.initial([three]))
    )

    // Assert — every resource keys uniquely across the whole file
    const keys = previews.flatMap((p) =>
      p.outcome._tag === 'resources' ? p.outcome.resources.map((r) => r.key) : []
    )
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.length).toBe(6)
  })

  it('should tag a response with no chosen pick as noPick without parsing anything', async () => {
    // Arrange — the response is recognized but every kind is disabled
    const pool = [patientKind]
    const responses = [input('r0', 'https://ehr.test/Patient/1')]
    const selection = Review.toggleKind(Review.initial(pool), 'patient')

    // Act
    const previews = await Effect.runPromise(Review.preview(pool, responses, selection))

    // Assert
    expect(previews[0]?.outcome._tag).toBe('noPick')
    expect(Option.isNone(previews[0]?.pickKindName ?? Option.none())).toBe(true)
  })
})

describe('Review.chosenResources', () => {
  it('should default to every previewed resource included', async () => {
    // Arrange
    const three = kindReturning('three', 50, '/many', ['a', 'b', 'c'])
    const responses = [input('r-many', 'https://ehr.test/many')]
    const previews = await Effect.runPromise(
      Review.preview([three], responses, Review.initial([three]))
    )

    // Act
    const chosen = Review.chosenResources(previews, Review.initial([three]))

    // Assert
    expect(chosen).toEqual(['a', 'b', 'c'])
  })

  it('should drop exactly the resource its key names when toggled off', async () => {
    // Arrange
    const three = kindReturning('three', 50, '/many', ['a', 'b', 'c'])
    const responses = [input('r-many', 'https://ehr.test/many')]
    const previews = await Effect.runPromise(
      Review.preview([three], responses, Review.initial([three]))
    )
    const selection = Review.toggleResource(Review.initial([three]), 'r-many:1')

    // Act
    const chosen = Review.chosenResources(previews, selection)

    // Assert — exactly the middle resource is dropped; the other two ride through
    expect(chosen).toEqual(['a', 'c'])
  })

  it('should drop every resource of a response whose kind was toggled off', async () => {
    // Arrange
    const twoPatients = kindReturning('patient', 50, '/Patient', ['p1', 'p2'])
    const twoObs = kindReturning('observation', 50, '/Observation', ['o1', 'o2'])
    const responses = [
      input('r-p', 'https://ehr.test/Patient/1'),
      input('r-o', 'https://ehr.test/Observation?s=1'),
    ]

    // Preview with everything on, then toggle observation off and re-preview
    const initial = Review.initial([twoPatients, twoObs])
    const previewsAll = await Effect.runPromise(
      Review.preview([twoPatients, twoObs], responses, initial)
    )
    const chosenAll = Review.chosenResources(previewsAll, initial)
    expect(chosenAll.toSorted()).toEqual(['o1', 'o2', 'p1', 'p2'])

    const observationOff = Review.toggleKind(initial, 'observation')
    const previewsAfter = await Effect.runPromise(
      Review.preview([twoPatients, twoObs], responses, observationOff)
    )

    // Act
    const chosen = Review.chosenResources(previewsAfter, observationOff)

    // Assert — every observation is dropped; both patients ride through
    expect(chosen.toSorted()).toEqual(['p1', 'p2'])
  })

  it('should be equal to the initial included set under any sequence of no-op toggles (property)', async () => {
    // A property: for any batch and any sequence of resource toggles that
    // cancel out, the chosen set matches the default. Keeps `toggleResource`
    // pure and self-inverse.
    const three = kindReturning('three', 50, '/many', ['a', 'b', 'c'])
    const responses = [input('r-many', 'https://ehr.test/many')]
    const initial = Review.initial([three])
    const previews = await Effect.runPromise(Review.preview([three], responses, initial))

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('r-many:0', 'r-many:1', 'r-many:2'), {
          minLength: 0,
          maxLength: 8,
        }),
        async (keys) => {
          // Toggle twice for each key so the outcome is a no-op.
          let selection = initial
          for (const key of keys) selection = Review.toggleResource(selection, key)
          for (const key of keys) selection = Review.toggleResource(selection, key)
          expect(Review.chosenResources(previews, selection)).toEqual(['a', 'b', 'c'])
        }
      ),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})

describe('Review.chosen', () => {
  it('should decode only the responses with a chosen pick', async () => {
    // Arrange — one Patient, one Observation, one unrecognized.
    const pool = [patientKind, observationKind]
    const responses = [
      input('r0', 'https://ehr.test/Patient/1'),
      input('r1', 'https://ehr.test/Observation?subject=1'),
      input('r2', 'https://ehr.test/nothing'),
    ]

    // Act
    const outcome = await Effect.runPromise(Review.chosen(pool, responses, Review.initial(pool)))

    // Assert — each recognized response decoded to its kind's name; the miss wrote nothing.
    expect(outcome.resources.toSorted()).toEqual(['observation', 'patient'])
    expect(outcome.parseFailures).toBe(0)
    expect(outcome.bodyAbsent).toBe(0)
  })

  it('should not decode a response whose only pick was disabled', async () => {
    // Arrange
    const pool = [patientKind, observationKind]
    const responses = [
      input('r0', 'https://ehr.test/Patient/1'),
      input('r1', 'https://ehr.test/Observation?subject=1'),
    ]
    const selection = Review.toggleKind(Review.initial(pool), 'observation')

    // Act
    const outcome = await Effect.runPromise(Review.chosen(pool, responses, selection))

    // Assert — the Observation was opted out, so only the Patient decoded.
    expect(outcome.resources).toEqual(['patient'])
    expect(outcome.parseFailures).toBe(0)
    expect(outcome.bodyAbsent).toBe(0)
  })

  it('should surface absent-body count when a recognized response has no body', async () => {
    // Arrange — a recognized Patient URL whose body the archive did not capture.
    const pool = [patientKind]
    const responses = [input('r0', 'https://ehr.test/Patient/1', true)]

    // Act
    const outcome = await Effect.runPromise(Review.chosen(pool, responses, Review.initial(pool)))

    // Assert
    expect(outcome.resources).toEqual([])
    expect(outcome.parseFailures).toBe(0)
    expect(outcome.bodyAbsent).toBe(1)
  })

  it('should drop an excluded resource from the chosen set', async () => {
    // Arrange
    const three = kindReturning('three', 50, '/many', ['a', 'b', 'c'])
    const responses = [input('r-many', 'https://ehr.test/many')]
    const selection = Review.toggleResource(Review.initial([three]), 'r-many:0')

    // Act
    const outcome = await Effect.runPromise(Review.chosen([three], responses, selection))

    // Assert — exactly the opted-out first resource is dropped
    expect(outcome.resources).toEqual(['b', 'c'])
  })
})

describe('Review.chosenCount', () => {
  it('should count only the responses that resolve to a pick', () => {
    // Arrange
    const pool = [patientKind, observationKind]
    const responses = [
      input('r0', 'https://ehr.test/Patient/1'),
      input('r1', 'https://ehr.test/nothing'),
    ]
    const recognized = Review.recognize(pool, responses)

    // Act / Assert
    expect(Review.chosenCount(recognized, Review.initial(pool))).toBe(1)
  })
})
