import { globSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

// scripts/ sits directly under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const TEST_FILE_GLOBS = ['**/*.test.ts', '**/*.test.tsx', '**/*.test.mts', '**/*.test.cts']

/** Directory names holding dependencies or build output rather than source. */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'dist-html',
  'dist-web',
  'coverage',
  'target',
  'vendor',
])

const isIgnored = (relativePath: string): boolean =>
  relativePath.split(sep).some((segment) => IGNORED_DIRECTORIES.has(segment))

/**
 * Every test file in the working tree, derived from the tree rather than a
 * checked-in list so a newly added property test is covered the moment it
 * lands.
 */
const testFiles = (): readonly string[] =>
  globSync(TEST_FILE_GLOBS, { cwd: repoRoot, exclude: isIgnored }).toSorted()

/**
 * True when `source` runs a fast-check property without routing its iteration
 * count through `numRunsFor` — see the `numRuns` rule in
 * [Property Testing Reference](../docs/Testing/Property%20Testing%20Reference.md).
 *
 * @remarks
 * File-scoped on purpose: `numRunsFor` is routinely hoisted into a shared
 * `const RUNS = numRunsFor({ base: 25 })` spent across several asserts, so
 * demanding it inside each `fc.assert(...)` argument list would reject the
 * idiom the docs recommend. That leaves one compliant assert beside one bare
 * assert in the same file uncovered — not the failure mode seen in the wild,
 * where every offender had zero `numRunsFor` references.
 */
const skipsRiskScaling = (source: string): boolean =>
  source.includes('fc.assert(') && !source.includes('numRunsFor')

describe('property tests pass numRuns through numRunsFor', () => {
  it('no test file calls fc.assert without a numRunsFor in the same file', () => {
    const offenders = testFiles().filter((file) =>
      skipsRiskScaling(readFileSync(join(repoRoot, file), 'utf8'))
    )
    expect(offenders).toEqual([])
  })

  // Without this, a glob that stopped matching (a moved scripts/, an `exclude`
  // that over-prunes) would leave the sweep above passing vacuously.
  it('sweeps the whole repo, not an empty or truncated file list', () => {
    const files = testFiles()
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(join('scripts', 'property-test-num-runs.test.ts'))
    expect(files.some((file) => file.startsWith(`slices${sep}`))).toBe(true)
    expect(files.some((file) => file.includes('node_modules'))).toBe(false)
  })
})

describe('skipsRiskScaling', () => {
  it('flags an fc.assert with no options argument', () => {
    expect(skipsRiskScaling('fc.assert(fc.property(arb, (x) => x === x))')).toBe(true)
  })

  it('flags an fc.assert with a hardcoded numRuns', () => {
    expect(skipsRiskScaling('fc.assert(prop, { numRuns: 100 })')).toBe(true)
  })

  it('accepts an fc.assert whose numRuns comes from numRunsFor', () => {
    expect(skipsRiskScaling('fc.assert(prop, { numRuns: numRunsFor({ base: 100 }) })')).toBe(false)
  })

  it('accepts a numRunsFor hoisted into a shared constant', () => {
    const source = [
      'const RUNS = numRunsFor({ base: 25, minimum: 5 })',
      'fc.assert(first, { numRuns: RUNS })',
      'fc.assert(second, { numRuns: RUNS })',
    ].join('\n')
    expect(skipsRiskScaling(source)).toBe(false)
  })

  it('ignores a file with no properties at all', () => {
    expect(skipsRiskScaling('expect(1 + 1).toBe(2)')).toBe(false)
  })
})
