import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  buildRiskMap,
  loadPackages,
  partitionWorkspaceGlobs,
  readWorkspaceGlobs,
} from './risk-map.ts'

// scripts/ sits directly under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('risk-map / pnpm-workspace.yaml reconciliation', () => {
  it('reads the workspace globs straight from pnpm-workspace.yaml', () => {
    const { positive, negative } = readWorkspaceGlobs(repoRoot)
    // These roots MUST come from the file, not a second hardcoded copy.
    expect(positive).toContain('apps/*')
    expect(positive).toContain('slices/**')
    // The self-hosted-apps exclusion is a negation, not a member glob.
    expect(negative).toContain('slices/apps/self-hosted-apps/**')
  })

  it('emits every workspace-matched package into the risk map', () => {
    const packages = Effect.runSync(loadPackages(repoRoot))
    const names = packages.map((p) => p.name)
    const map = buildRiskMap(packages, new Set(names))
    // `kitchen-sink` lives at global/kitchen-sink, matched by the `global/*`
    // workspace glob — deriving from the YAML MUST surface it in the map.
    expect(Object.keys(map)).toContain('kitchen-sink')
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(map[name]).toBeTypeOf('number')
  })

  it('honors the !slices/apps/self-hosted-apps negation', () => {
    const packages = Effect.runSync(loadPackages(repoRoot))
    const selfHosted = packages.filter((p) => p.relDir.startsWith('slices/apps/self-hosted-apps'))
    expect(selfHosted).toEqual([])
  })

  it('partitions !-prefixed entries into negations, others into positives', () => {
    fc.assert(
      // A single `!` is pnpm's negation prefix; `!!`-prefixed entries aren't a
      // real workspace shape and would leave an inner `!` after one strip, so
      // exclude them from the inputs to keep the `!`-free invariant below.
      fc.property(fc.array(fc.string().filter((s) => !s.startsWith('!!'))), (entries) => {
        const { positive, negative } = partitionWorkspaceGlobs(entries)
        expect(positive).toEqual(entries.filter((e) => !e.startsWith('!')))
        expect(negative).toEqual(entries.filter((e) => e.startsWith('!')).map((e) => e.slice(1)))
        for (const n of negative) expect(n.startsWith('!')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})
