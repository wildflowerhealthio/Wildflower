import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { normalizeName, tokenize } from './normalize.ts'
import { confidenceRank, isTokenSubset, scoreName } from './score.ts'

describe('scoreName', () => {
  it('should score names that normalize equal as exact', () => {
    expect(scoreName('ABILIFY', 'Abilify®')).toBe('exact')
  })

  it('should score a candidate contained in a fuller medication name as strong', () => {
    expect(scoreName('Abilify 5 mg tablet', 'Abilify')).toBe('strong')
  })

  it('should score a medication name contained in a fuller candidate as partial', () => {
    expect(scoreName('risedronate', 'risedronate sodium')).toBe('partial')
  })

  it('should return null when the names share no containment', () => {
    expect(scoreName('ibuprofen', 'Abilify')).toBeNull()
  })

  it('should return null when either side normalizes to nothing', () => {
    expect(scoreName('', 'Abilify')).toBeNull()
    expect(scoreName('Abilify', '®™')).toBeNull()
  })

  it('should always score a name against itself as exact when it has tokens', () => {
    fc.assert(
      fc.property(
        fc.string().filter((name) => normalizeName(name).length > 0),
        (name) => {
          expect(scoreName(name, name)).toBe('exact')
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never return strong or partial for names with the same token set', () => {
    // Prepending / appending noise (strength tokens) to a name does not change
    // its tokens, so the score can only ever be exact or null — never a
    // containment grade.
    fc.assert(
      fc.property(fc.string(), (name) => {
        const noisy = `12 mg ${name} 500mg`
        const score = scoreName(noisy, name)
        expect(score === 'exact' || score === null).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should score strong and partial as mirror images of each other', () => {
    // Swapping the arguments turns a strong containment into a partial one and
    // vice versa; exact and null are symmetric.
    const mirror = { exact: 'exact', strong: 'partial', partial: 'strong', null: null } as const
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const forward = scoreName(a, b)
        const backward = scoreName(b, a)
        expect(backward).toBe(mirror[forward ?? 'null'])
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('isTokenSubset', () => {
  it('should be false for an empty needle', () => {
    expect(isTokenSubset([], ['a'])).toBe(false)
  })

  it('should be true when every needle token is in the haystack', () => {
    expect(isTokenSubset(['a', 'b'], ['b', 'c', 'a'])).toBe(true)
  })

  it("should always accept a name's own tokens as a subset of a longer name", () => {
    fc.assert(
      fc.property(
        fc.string().filter((name) => tokenize(name).length > 0),
        fc.string(),
        (name, extra) => {
          expect(isTokenSubset(tokenize(name), tokenize(`${extra} ${name}`))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('confidenceRank', () => {
  it('should rank exact above strong above partial', () => {
    expect(confidenceRank.exact).toBeGreaterThan(confidenceRank.strong)
    expect(confidenceRank.strong).toBeGreaterThan(confidenceRank.partial)
  })
})
