import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { numRunsFor, scaleNumRuns } from './num-runs-for.ts'

describe('scaleNumRuns', () => {
  it('should return base unchanged when the multiplier is 1', () => {
    // Arrange / Act
    const result = scaleNumRuns(100, 1)

    // Assert
    expect(result).toBe(100)
  })

  it('should scale base down by a sub-1 multiplier', () => {
    // Arrange / Act
    const result = scaleNumRuns(100, 0.2)

    // Assert
    expect(result).toBe(20)
  })

  it('should floor at 10 when scaling would drop below it', () => {
    // Arrange / Act — 30 * 0.2 = 6, floored up to 10
    const result = scaleNumRuns(30, 0.2)

    // Assert
    expect(result).toBe(10)
  })

  it('should leave a deliberately tiny base untouched', () => {
    // Arrange / Act — base below the 10 floor is not raised
    const result = scaleNumRuns(5, 0.2)

    // Assert
    expect(result).toBe(5)
  })

  it('should default the floor to 10 when minimum is omitted', () => {
    // Arrange / Act — 30 * 0.2 = 6, floored up to the default 10
    const result = scaleNumRuns(30, 0.2)

    // Assert
    expect(result).toBe(10)
  })

  it('should honor an explicit minimum floor', () => {
    // Arrange / Act — 100 * 0.2 = 20, but a minimum of 25 raises it
    const result = scaleNumRuns(100, 0.2, 25)

    // Assert
    expect(result).toBe(25)
  })

  it('should not raise above base even when minimum exceeds base', () => {
    // Arrange / Act — minimum 50 cannot pull a base of 8 above itself
    const result = scaleNumRuns(8, 0.2, 50)

    // Assert
    expect(result).toBe(8)
  })

  it('should never return fewer runs than min(minimum, base) for a sub-1 multiplier', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 0, max: 0.999, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 1000 }),
        (base, multiplier, minimum) => {
          const result = scaleNumRuns(base, multiplier, minimum)
          expect(result).toBeGreaterThanOrEqual(Math.min(minimum, base))
          expect(result).toBeLessThanOrEqual(base)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should stay within [min(10, base), base] under the default floor for any sub-1 multiplier', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 0, max: 0.999, noNaN: true, noDefaultInfinity: true }),
        (base, multiplier) => {
          const result = scaleNumRuns(base, multiplier)
          expect(result).toBeGreaterThanOrEqual(Math.min(10, base))
          expect(result).toBeLessThanOrEqual(base)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should return base for any multiplier at or above 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (base, multiplier) => {
          expect(scaleNumRuns(base, multiplier)).toBe(base)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('numRunsFor (end to end via FC_RUN_SCALE)', () => {
  const originalRunScale = process.env.FC_RUN_SCALE

  afterEach(() => {
    if (originalRunScale === undefined) delete process.env.FC_RUN_SCALE
    else process.env.FC_RUN_SCALE = originalRunScale
  })

  it('should return base unchanged when FC_RUN_SCALE is unset', () => {
    // Arrange
    delete process.env.FC_RUN_SCALE

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(100)
  })

  it('should scale down by a reduced FC_RUN_SCALE', () => {
    // Arrange
    process.env.FC_RUN_SCALE = '0.2'

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(20)
  })

  it('should not scale at a full FC_RUN_SCALE', () => {
    // Arrange
    process.env.FC_RUN_SCALE = '1'

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(100)
  })

  it('should honor an explicit minimum floor when scaling down', () => {
    // Arrange
    process.env.FC_RUN_SCALE = '0.2'

    // Act / Assert — 100 * 0.2 = 20, but minimum 25 raises the floor.
    expect(numRunsFor({ base: 100, minimum: 25 })).toBe(25)
  })

  it('should return base unchanged when FC_RUN_SCALE is not a run scale', () => {
    for (const value of ['not a number', '', '-0.5', 'Infinity', 'NaN']) {
      // Arrange
      process.env.FC_RUN_SCALE = value

      // Act / Assert
      expect(numRunsFor({ base: 100 }), value).toBe(100)
    }
  })
})
