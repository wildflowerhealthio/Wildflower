import { Option } from 'effect'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { multiplierFromMap, numRunsFor, scaleNumRuns } from './num-runs-for.ts'

// This test file lives in the `kitchen-sink` package, so `numRunsFor` resolves
// its calling package to `kitchen-sink` (via the call stack). Keying the risk
// map under that name exercises the real end-to-end path that `test:changed`
// relies on, proving the multiplier actually reaches `numRunsFor` at runtime.
const THIS_PACKAGE = 'kitchen-sink'

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

  it('should never exceed base for any sub-1 multiplier', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (base, multiplier) => {
          const result = scaleNumRuns(base, multiplier)
          expect(result).toBeLessThanOrEqual(base)
        }
      ),
      { numRuns: numRunsFor(200) }
    )
  })

  it('should never return fewer runs than min(10, base) for a sub-1 multiplier', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 0, max: 0.999, noNaN: true, noDefaultInfinity: true }),
        (base, multiplier) => {
          const result = scaleNumRuns(base, multiplier)
          expect(result).toBeGreaterThanOrEqual(Math.min(10, base))
        }
      ),
      { numRuns: numRunsFor(200) }
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
      { numRuns: numRunsFor(200) }
    )
  })
})

describe('multiplierFromMap', () => {
  it('should default to 1 when the package is absent and there is no wildcard', () => {
    // Arrange / Act
    const result = multiplierFromMap({ 'other-pkg': 0.2 }, Option.some('my-pkg'))

    // Assert
    expect(result).toBe(1)
  })

  it('should read the per-package multiplier when present', () => {
    // Arrange / Act
    const result = multiplierFromMap({ 'my-pkg': 0.2 }, Option.some('my-pkg'))

    // Assert
    expect(result).toBe(0.2)
  })

  it('should let the wildcard apply to every package', () => {
    // Arrange / Act
    const result = multiplierFromMap({ '*': 0.3 }, Option.some('any-pkg'))

    // Assert
    expect(result).toBe(0.3)
  })

  it('should prefer the wildcard over a per-package entry', () => {
    // Arrange / Act
    const result = multiplierFromMap({ '*': 0.3, 'my-pkg': 0.5 }, Option.some('my-pkg'))

    // Assert
    expect(result).toBe(0.3)
  })

  it('should default to 1 when the package name cannot be resolved', () => {
    // Arrange / Act
    const result = multiplierFromMap({ 'my-pkg': 0.2 }, Option.none())

    // Assert
    expect(result).toBe(1)
  })
})

describe('numRunsFor (end to end via FC_RISK_MAP)', () => {
  const original = process.env.FC_RISK_MAP

  afterEach(() => {
    if (original === undefined) delete process.env.FC_RISK_MAP
    else process.env.FC_RISK_MAP = original
  })

  it('should return base unchanged when FC_RISK_MAP is unset', () => {
    // Arrange
    delete process.env.FC_RISK_MAP

    // Act / Assert
    expect(numRunsFor(100)).toBe(100)
  })

  it("should scale down when this package's multiplier is low", () => {
    // Arrange — the multiplier resolved from the running test file's package.
    process.env.FC_RISK_MAP = JSON.stringify({ [THIS_PACKAGE]: 0.2 })

    // Act / Assert — 100 * 0.2 = 20: proves the env actually reaches runtime.
    expect(numRunsFor(100)).toBe(20)
  })

  it("should not scale when this package's multiplier is high", () => {
    // Arrange
    process.env.FC_RISK_MAP = JSON.stringify({ [THIS_PACKAGE]: 1.0 })

    // Act / Assert
    expect(numRunsFor(100)).toBe(100)
  })

  it('should scale down under a wildcard multiplier', () => {
    // Arrange
    process.env.FC_RISK_MAP = JSON.stringify({ '*': 0.2 })

    // Act / Assert
    expect(numRunsFor(100)).toBe(20)
  })

  it('should not scale when this package is absent from the map', () => {
    // Arrange — only an unrelated package is listed.
    process.env.FC_RISK_MAP = JSON.stringify({ 'some-other-package': 0.2 })

    // Act / Assert
    expect(numRunsFor(100)).toBe(100)
  })

  it('should return base unchanged when FC_RISK_MAP is malformed JSON', () => {
    // Arrange
    process.env.FC_RISK_MAP = 'not json'

    // Act / Assert
    expect(numRunsFor(100)).toBe(100)
  })
})
