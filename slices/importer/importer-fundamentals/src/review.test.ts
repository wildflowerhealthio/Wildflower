import { DateTime, Effect, Option } from 'effect'

import type { Extraction } from 'http-extraction-fundamentals'
import { HttpResponseKind } from 'http-extraction-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import * as Review from './review.ts'

/**
 * The per-response review model is pure selection state — no DOM, no
 * framework — so it is driven directly: a fixed pool of response kinds, a set of
 * inputs, and the transitions over the selection they produce. The two axes are
 * exercised apart and together: whole-import kind toggles re-derive every
 * response's pick, per-response overrides win only when they name a
 * still-enabled candidate, and {@link Review.chosen} decodes only what the
 * selection opted into.
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

/** A `patient` kind (mid specificity) and an `observation` kind (higher) — disjoint tokens. */
const patientKind = kind('patient', 50, '/Patient')
const observationKind = kind('observation', 50, '/Observation')
/** A broad `portal` kind (low specificity) that also claims `/Patient`, to force an overlap. */
const portalKind = kind('portal', 10, '/Patient')

/** One decoded response the recognizer reads. */
const input = (id: string, url: string, bodyAbsent = false): Extraction.Input => ({
  id,
  url,
  status: 200,
  statusText: 'OK',
  headers: [],
  startedAt: DateTime.unsafeNow(),
  body: new Uint8Array(),
  bodyAbsent,
})

describe('Review.initial', () => {
  it('should enable every kind in the pool and hold no overrides', () => {
    // Arrange
    const pool = [patientKind, observationKind]

    // Act
    const selection = Review.initial(pool)

    // Assert
    expect(selection.enabledKinds).toEqual(new Set(['patient', 'observation']))
    expect(selection.overrides.size).toBe(0)
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
    const resources = await Effect.runPromise(Review.chosen(pool, responses, Review.initial(pool)))

    // Assert — each recognized response decoded to its kind's name; the miss wrote nothing.
    expect(resources.toSorted()).toEqual(['observation', 'patient'])
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
    const resources = await Effect.runPromise(Review.chosen(pool, responses, selection))

    // Assert — the Observation was opted out, so only the Patient decoded.
    expect(resources).toEqual(['patient'])
  })

  it('should write nothing when a body is absent even though the URL was recognized', async () => {
    // Arrange — a recognized Patient URL whose body the archive did not capture.
    const pool = [patientKind]
    const responses = [input('r0', 'https://ehr.test/Patient/1', true)]

    // Act
    const resources = await Effect.runPromise(Review.chosen(pool, responses, Review.initial(pool)))

    // Assert
    expect(resources).toEqual([])
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
