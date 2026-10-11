#!/usr/bin/env node
// Emits a JSON map of `{ <pkgName>: <multiplier> }` for the kitchen-sink
// `numRunsFor` helper to consume via the FC_RISK_MAP env var. Packages
// reachable in the reverse workspace dep graph from a changed file get the
// HIGH multiplier (1.0); everything else gets LOW (0.2). Root-config or
// lockfile changes promote every package to HIGH.
import { Console, Effect, Schema } from 'effect'

import { loadAffectedPackages, repoRootFromGit } from './affected-packages.ts'
import type { Pkg } from './affected-packages.ts'
import { isEntrypoint } from './entrypoint.ts'

const HIGH = 1.0
const LOW = 0.2

const RiskMap = Schema.Record({ key: Schema.String, value: Schema.Number })
const encodeRiskMap = Schema.encodeSync(RiskMap)

const buildRiskMap = (
  packages: readonly Pkg[],
  highRisk: ReadonlySet<string>
): Record<string, number> => {
  const map: Record<string, number> = {}
  for (const p of packages) map[p.name] = highRisk.has(p.name) ? HIGH : LOW
  return map
}

const formatSummary = (
  highRisk: ReadonlySet<string>,
  totalPackages: number,
  directlyChanged: number
): string => {
  const highList = [...highRisk].toSorted()
  const lowCount = totalPackages - highRisk.size
  const head = `risk: ${highRisk.size} high (${HIGH}), ${lowCount} low (${LOW}) — changed: ${directlyChanged}`
  if (highList.length === 0) return head
  if (highList.length <= 20) return `${head}\n  high: ${highList.join(', ')}`
  return `${head}\n  high (first 20): ${highList.slice(0, 20).join(', ')}, ...`
}

const main = Effect.gen(function* () {
  const repoRoot = yield* repoRootFromGit
  const { packages, affectedPackages } = yield* loadAffectedPackages(repoRoot)

  const [rootConfigChange] = affectedPackages.rootConfigChanges
  if (rootConfigChange !== undefined) {
    const map = Object.fromEntries(packages.map((p) => [p.name, HIGH]))
    yield* Console.error(
      `risk: root config changed (${rootConfigChange}) — all ${packages.length} packages at high risk (${HIGH})`
    )
    yield* Console.log(JSON.stringify(encodeRiskMap(map)))
    return
  }

  // A change outside every package (docs, scripts, CI) raises no package's risk.
  const highRisk = affectedPackages.affected
  const map = buildRiskMap(packages, highRisk)

  yield* Console.error(formatSummary(highRisk, packages.length, affectedPackages.changed.size))
  yield* Console.log(JSON.stringify(encodeRiskMap(map)))
})

if (isEntrypoint(import.meta.url)) Effect.runSync(Effect.orDie(main))

export { buildRiskMap }
