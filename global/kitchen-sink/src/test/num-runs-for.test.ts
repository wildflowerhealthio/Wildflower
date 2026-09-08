import { existsSync } from 'node:fs'
import { dirname, parse as parsePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { multiplierFromMap, numRunsFor, scaleNumRuns } from './num-runs-for.ts'

// This test file lives in the `kitchen-sink` package, so `numRunsFor` resolves
// its calling package to `kitchen-sink` (via Vitest's `__vitest_worker__.filepath`,
// with a call-stack fallback). Keying the risk map under that name exercises the
// real end-to-end path that `test:changed` relies on, proving the multiplier
// actually reaches `numRunsFor` at runtime.
const THIS_PACKAGE = 'kitchen-sink'

// The monorepo root's own package name. The old cwd-based implementation
// resolved to this when run from the repo root (Vitest projects mode), so the
// risk-map multiplier never matched a real package and scaling silently no-oped.
const MONOREPO_PACKAGE = 'wildflower-monorepo'

// Absolute path to the monorepo root, found by walking up from this file to the
// `pnpm-workspace.yaml` marker. Used to reproduce the projects-mode worker cwd.
const repoRoot = ((): string => {
  let dir = dirname(fileURLToPath(import.meta.url))
  const fsRoot = parsePath(dir).root
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir || dir === fsRoot) {
      throw new Error('could not locate monorepo root (no pnpm-workspace.yaml ancestor)')
    }
    dir = parent
  }
})()

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
  const originalRiskMap = process.env.FC_RISK_MAP
  const originalCwd = process.cwd()

  afterEach(() => {
    if (originalRiskMap === undefined) delete process.env.FC_RISK_MAP
    else process.env.FC_RISK_MAP = originalRiskMap
    process.chdir(originalCwd)
  })

  it('should return base unchanged when FC_RISK_MAP is unset', () => {
    // Arrange
    delete process.env.FC_RISK_MAP

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(100)
  })

  it("should scale down using this package's multiplier even when cwd is the monorepo root", () => {
    // Arrange — reproduce Vitest projects mode, where the worker cwd is the
    // monorepo root, not the package dir. Map kitchen-sink and the monorepo
    // root to DIFFERENT multipliers so the resolved package is observable from
    // the result alone.
    process.chdir(repoRoot)
    process.env.FC_RISK_MAP = JSON.stringify({ [THIS_PACKAGE]: 0.2, [MONOREPO_PACKAGE]: 0.5 })

    // Act
    const result = numRunsFor({ base: 100 })

    // Assert — 100 * 0.2 = 20 (kitchen-sink), NOT 100 * 0.5 = 50 (the monorepo
    // root the old cwd-based impl would have resolved). This pins the bug: a
    // cwd-based resolver run from the root reads `wildflower-monorepo` and would
    // return 50 here, so this case fails under the no-op it guards against.
    expect(result).toBe(20)
    expect(result).not.toBe(50)
  })

  it("should not scale when this package's multiplier is high", () => {
    // Arrange
    process.env.FC_RISK_MAP = JSON.stringify({ [THIS_PACKAGE]: 1.0 })

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(100)
  })

  it('should honor an explicit minimum floor when scaling down', () => {
    // Arrange
    process.env.FC_RISK_MAP = JSON.stringify({ [THIS_PACKAGE]: 0.2 })

    // Act / Assert — 100 * 0.2 = 20, but minimum 25 raises the floor.
    expect(numRunsFor({ base: 100, minimum: 25 })).toBe(25)
  })

  it('should scale down under a wildcard multiplier', () => {
    // Arrange
    process.env.FC_RISK_MAP = JSON.stringify({ '*': 0.2 })

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(20)
  })

  it('should not scale when this package is absent from the map', () => {
    // Arrange — only an unrelated package is listed.
    process.env.FC_RISK_MAP = JSON.stringify({ 'some-other-package': 0.2 })

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(100)
  })

  it('should return base unchanged when FC_RISK_MAP is malformed JSON', () => {
    // Arrange
    process.env.FC_RISK_MAP = 'not json'

    // Act / Assert
    expect(numRunsFor({ base: 100 })).toBe(100)
  })
})
