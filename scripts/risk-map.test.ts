import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { loadPackages } from './affected-packages.ts'
import { buildRiskMap } from './risk-map.ts'

// scripts/ sits directly under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('risk-map', () => {
  it('emits every workspace-matched package into the risk map', () => {
    const packages = Effect.runSync(loadPackages(repoRoot))
    const names = packages.map((p) => p.name)
    const map = buildRiskMap(packages, new Set(names))
    // `kitchen-sink` lives at global/kitchen-sink, matched by the `global/*`
    // workspace glob — deriving from the YAML MUST surface it in the map.
    expect(Object.keys(map)).toContain('@wildflowerhealthio/kitchen-sink')
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(map[name]).toBeTypeOf('number')
  })
})
