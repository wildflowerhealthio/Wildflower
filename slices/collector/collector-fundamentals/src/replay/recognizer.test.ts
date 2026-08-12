import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { resolve, type Recognizer } from './recognizer.ts'
import { replayResponse } from './replay-entities.test-helpers.ts'
import type { ReplayResponse } from './replay-entities.ts'

const responses: readonly ReplayResponse[] = [
  replayResponse({ id: 'r1', url: 'https://portal.example.com/carebook/summary' }),
  replayResponse({ id: 'r2', url: 'https://fhir.example.com/baseR4/Patient/1' }),
]

/** A recognizer carrying a caller-owned payload, as a real registration would. */
interface Registered extends Recognizer {
  readonly collectorTag: string
}

const recognizer = (
  name: string,
  specificity: number,
  claims: (rs: readonly ReplayResponse[]) => boolean
): Registered => ({ name, specificity, claims, collectorTag: `${name}-tag` })

const PortalRecognizer = recognizer('portal', 30, (rs) =>
  rs.some((r) => r.url.includes('portal.example.com'))
)
const FhirRecognizer = recognizer('fhir', 20, (rs) => rs.some((r) => r.url.includes('/baseR4/')))
const CatchAllRecognizer = recognizer('catchAll', 10, () => true)

describe('Recognizer.resolve', () => {
  it('picks the more specific of two recognizers that both claim', () => {
    const winner = resolve([CatchAllRecognizer, FhirRecognizer, PortalRecognizer], responses)

    expect(Option.getOrNull(winner)).toBe(PortalRecognizer)
  })

  it('falls back to a less specific recognizer when the specific one abstains', () => {
    const winner = resolve(
      [CatchAllRecognizer, FhirRecognizer, PortalRecognizer],
      [replayResponse({ id: 'r1', url: 'https://fhir.example.com/baseR4/Observation?subject=1' })]
    )

    expect(Option.getOrNull(winner)).toBe(FhirRecognizer)
  })

  it('returns None when nothing claims', () => {
    expect(resolve([PortalRecognizer, FhirRecognizer], [])).toEqual(Option.none())
  })

  it("carries the caller's payload through untouched", () => {
    const winner = resolve([CatchAllRecognizer, PortalRecognizer], responses)

    expect(Option.map(winner, (r) => r.collectorTag)).toEqual(Option.some('portal-tag'))
  })

  test('property: the winner is a claiming recognizer of maximal specificity, whatever the list order', () => {
    const candidates = [PortalRecognizer, FhirRecognizer, CatchAllRecognizer]

    fc.assert(
      fc.property(
        fc.shuffledSubarray(candidates, { minLength: 1 }),
        fc.subarray([...responses], { minLength: 0 }),
        (shuffled, input) => {
          const winner = resolve(shuffled, input)
          const claiming = shuffled.filter((r) => r.claims(input))

          if (claiming.length === 0) {
            expect(winner).toEqual(Option.none())
            return
          }
          const best = Math.max(...claiming.map((r) => r.specificity))
          expect(Option.map(winner, (r) => r.specificity)).toEqual(Option.some(best))
          expect(claiming).toContain(Option.getOrNull(winner))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: ties break toward the earlier candidate', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), (specificity) => {
        const first = recognizer('first', specificity, () => true)
        const second = recognizer('second', specificity, () => true)

        expect(Option.getOrNull(resolve([first, second], responses))).toBe(first)
        expect(Option.getOrNull(resolve([second, first], responses))).toBe(second)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
