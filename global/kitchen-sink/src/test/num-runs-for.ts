import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Per-package multiplier read from `FC_RISK_MAP` (a JSON object keyed by
 * package name). When the env var is unset or the current package is absent,
 * the multiplier defaults to `1.0` — i.e. no reduction.
 *
 * Resolution happens once at module load. The current package name is read
 * from `<cwd>/package.json`, which under Vitest projects mode and Jest is
 * the package being tested.
 */
const numberFrom = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined

const readMultiplier = (): number => {
  const raw = process.env.FC_RISK_MAP
  if (!raw) return 1.0
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 1.0
  }
  if (typeof parsed !== 'object' || parsed === null) return 1.0
  const map: Record<string, unknown> = { ...parsed }
  const star = numberFrom(map['*'])
  if (star !== undefined) return star
  let pkgName: string
  try {
    const pkgRaw: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    if (typeof pkgRaw !== 'object' || pkgRaw === null) return 1.0
    const pkgRecord: Record<string, unknown> = { ...pkgRaw }
    const name = pkgRecord.name
    if (typeof name !== 'string') return 1.0
    pkgName = name
  } catch {
    return 1.0
  }
  const value = numberFrom(map[pkgName])
  return value ?? 1.0
}

const multiplier = readMultiplier()

/**
 * Scale a fast-check `numRuns` value by the current package's risk multiplier.
 *
 * Floors at `min(10, base)` so a non-trivial property still runs end-to-end
 * even when the package is low risk, but a test that intentionally requests
 * fewer than 10 runs is left untouched.
 *
 * When `FC_RISK_MAP` is unset (the default, including local `vp test`),
 * this returns `base` unchanged.
 *
 * @example
 * fc.assert(prop, { numRuns: numRunsFor(100) })
 *
 * @example
 * const REFERENCE_NUM_RUNS = numRunsFor(25)
 */
export const numRunsFor = (base: number): number => {
  if (multiplier >= 1) return base
  return Math.max(Math.min(10, base), Math.floor(base * multiplier))
}
