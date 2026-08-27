import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import type * as Extraction from './extraction.ts'
import { resolve } from './source.ts'
import { makeExtractionInput } from './test-helpers.ts'

const responses: readonly Extraction.Input[] = [
  makeExtractionInput({ id: 'r1', url: 'https://portal.example.com/carebook/summary' }),
  makeExtractionInput({ id: 'r2', url: 'https://fhir.example.com/baseR4/Patient/1' }),
]

/** A source-shaped candidate carrying a caller-owned payload, as a real `Source` would. */
interface Candidate {
  readonly name: string
  readonly specificity: number
  readonly claims: (rs: readonly Extraction.Input[]) => boolean
  readonly sourceTag: string
}

const candidate = (
  name: string,
  specificity: number,
  claims: (rs: readonly Extraction.Input[]) => boolean
): Candidate => ({ name, specificity, claims, sourceTag: `${name}-tag` })

const portalCandidate = candidate('portal', 30, (rs) =>
  rs.some((r) => r.url.includes('portal.example.com'))
)
const fhirCandidate = candidate('fhir', 20, (rs) => rs.some((r) => r.url.includes('/baseR4/')))
const catchAllCandidate = candidate('catchAll', 10, () => true)

describe('Source.resolve', () => {
  it('picks the more specific of two sources that both claim', () => {
    const winner = resolve([catchAllCandidate, fhirCandidate, portalCandidate], responses)

    expect(Option.getOrNull(winner)).toBe(portalCandidate)
  })

  it('falls back to a less specific source when the specific one abstains', () => {
    const winner = resolve(
      [catchAllCandidate, fhirCandidate, portalCandidate],
      [
        makeExtractionInput({
          id: 'r1',
          url: 'https://fhir.example.com/baseR4/Observation?subject=1',
        }),
      ]
    )

    expect(Option.getOrNull(winner)).toBe(fhirCandidate)
  })

  it('returns None when nothing claims', () => {
    expect(resolve([portalCandidate, fhirCandidate], [])).toEqual(Option.none())
  })

  it("carries the caller's payload through untouched", () => {
    const winner = resolve([catchAllCandidate, portalCandidate], responses)

    expect(Option.map(winner, (r) => r.sourceTag)).toEqual(Option.some('portal-tag'))
  })

  test('property: the winner is a claiming source of maximal specificity, whatever the list order', () => {
    const candidates = [portalCandidate, fhirCandidate, catchAllCandidate]

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
        const first = candidate('first', specificity, () => true)
        const second = candidate('second', specificity, () => true)

        expect(Option.getOrNull(resolve([first, second], responses))).toBe(first)
        expect(Option.getOrNull(resolve([second, first], responses))).toBe(second)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
