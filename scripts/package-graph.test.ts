import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  type DependencyKind,
  type Ecosystem,
  findCycles,
  formatViolation,
  loadWorkspacePackages,
  packageGraphViolations,
  type Violation,
  type WorkspacePackage,
} from './package-graph.ts'

// scripts/ sits directly under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('the workspace package graph', () => {
  it('breaks none of the package graph rules', () => {
    const packages = Effect.runSync(loadWorkspacePackages(repoRoot))
    expect(packageGraphViolations(packages).map(formatViolation)).toEqual([])
  })

  it('reads both ecosystems', () => {
    const packages = Effect.runSync(loadWorkspacePackages(repoRoot))
    const byName = new Map(packages.map((p) => [`${p.ecosystem}:${p.name}`, p]))
    // A TS package and a Rust crate each with a known workspace dependency:
    // reading either manifest wrong would drop the edge.
    expect(byName.get('npm:importer-react')?.runtimeDependencyNames).toContain('importer-core')
    expect(byName.get('cargo:host-app')?.runtimeDependencyNames).toContain('browser-sniffer-tauri')
  })
})

describe('findCycles', () => {
  /** Whether `to` is reachable from `from` in one or more steps. */
  const reaches = (
    adjacency: ReadonlyMap<string, ReadonlySet<string>>,
    from: string,
    to: string
  ): boolean => {
    const seen = new Set<string>()
    const queue = [...(adjacency.get(from) ?? [])]
    while (queue.length > 0) {
      const name = queue.shift()!
      if (name === to) return true
      if (seen.has(name)) continue
      seen.add(name)
      queue.push(...(adjacency.get(name) ?? []))
    }
    return false
  }

  const graphArbitrary = fc.integer({ min: 1, max: 8 }).chain((size) =>
    fc.array(fc.tuple(fc.nat(size - 1), fc.nat(size - 1)), { maxLength: size * 3 }).map((edges) => {
      const names = Array.from({ length: size }, (_, i) => `p${i}`)
      return new Map(
        names.map((name, i) => [
          name,
          new Set(edges.filter(([from]) => from === i).map(([, to]) => `p${to}`)),
        ])
      )
    })
  )

  it('puts two packages in one cycle exactly when each reaches the other', () => {
    fc.assert(
      fc.property(graphArbitrary, (adjacency) => {
        const cycles = findCycles(adjacency)
        const cycleOf = new Map(cycles.flatMap((cycle) => cycle.map((name) => [name, cycle])))
        for (const a of adjacency.keys()) {
          for (const b of adjacency.keys()) {
            if (a === b) continue
            const together = cycleOf.has(a) && cycleOf.get(a) === cycleOf.get(b)
            expect(together).toBe(reaches(adjacency, a, b) && reaches(adjacency, b, a))
          }
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('finds no cycle in a graph whose edges all point forward, self-dependencies included', () => {
    fc.assert(
      fc.property(graphArbitrary, (adjacency) => {
        const forward = new Map(
          [...adjacency].map(([name, dependencies]) => [
            name,
            new Set([...dependencies].filter((dependency) => dependency >= name)),
          ])
        )
        expect(findCycles(forward)).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('packageGraphViolations', () => {
  /** A package with no dependencies yet. */
  const packageAt = (
    name: string,
    relDir: string,
    ecosystem: Ecosystem = 'npm'
  ): WorkspacePackage => ({
    name,
    relDir,
    ecosystem,
    runtimeDependencyNames: new Set(),
    devDependencyNames: new Set(),
  })

  /** `dependent` with `dependency` added under `kind`. */
  const dependingOn = (
    dependent: WorkspacePackage,
    dependency: WorkspacePackage,
    kind: DependencyKind
  ): WorkspacePackage =>
    kind === 'runtime'
      ? {
          ...dependent,
          runtimeDependencyNames: new Set([...dependent.runtimeDependencyNames, dependency.name]),
        }
      : {
          ...dependent,
          devDependencyNames: new Set([...dependent.devDependencyNames, dependency.name]),
        }

  const tagsOf = (violations: readonly Violation[]): readonly string[] =>
    violations.map(({ _tag }) => _tag)

  const kindArbitrary = fc.constantFrom<DependencyKind>('runtime', 'dev')
  const stemArbitrary = fc.stringMatching(/^[a-z]{1,8}$/)
  const adapterSuffixArbitrary = fc.constantFrom(
    '-react',
    '-rust',
    '-tauri',
    '-tauri-js',
    '-node',
    '-web'
  )

  describe('a core and its dependencies', () => {
    it('flags a core depending on an adapter, of either kind', () => {
      fc.assert(
        fc.property(
          stemArbitrary,
          fc.constantFrom('-core', '-core-js'),
          adapterSuffixArbitrary,
          kindArbitrary,
          (stem, coreSuffix, adapterSuffix, kind) => {
            const core = packageAt(`${stem}${coreSuffix}`, `slices/${stem}/a`)
            const adapter = packageAt(`${stem}-x${adapterSuffix}`, `slices/${stem}/b`)
            expect(
              tagsOf(packageGraphViolations([dependingOn(core, adapter, kind), adapter]))
            ).toEqual(['CoreDependsOnAdapter'])
          }
        ),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })

    it('lets an adapter depend on a core, and a core on a core', () => {
      fc.assert(
        fc.property(stemArbitrary, adapterSuffixArbitrary, kindArbitrary, (stem, suffix, kind) => {
          const core = packageAt(`${stem}-core`, `slices/${stem}/a`)
          const otherCore = packageAt(`${stem}-other-core`, `slices/${stem}/b`)
          const adapter = packageAt(`${stem}${suffix}`, `slices/${stem}/c`)
          expect(
            packageGraphViolations([
              dependingOn(core, otherCore, kind),
              otherCore,
              dependingOn(adapter, core, kind),
            ])
          ).toEqual([])
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })

  describe("an app's folder", () => {
    it('is open to the packages inside it', () => {
      fc.assert(
        fc.property(stemArbitrary, kindArbitrary, (app, kind) => {
          const shared = packageAt(`${app}-thing`, `apps/${app}/${app}-thing`)
          const user = packageAt(`${app}-user`, `apps/${app}/${app}-user`)
          expect(packageGraphViolations([dependingOn(user, shared, kind), shared])).toEqual([])
        }),
        { numRuns: numRunsFor({ base: 30 }) }
      )
    })

    it('is closed to slices and global packages, even from their tests', () => {
      fc.assert(
        fc.property(
          stemArbitrary,
          fc.constantFrom('slices', 'global'),
          kindArbitrary,
          (app, root, kind) => {
            const insideApp = packageAt(`${app}-thing`, `apps/${app}/${app}-thing`)
            const outside = packageAt('outside', `${root}/outside`)
            expect(
              tagsOf(packageGraphViolations([dependingOn(outside, insideApp, kind), insideApp]))
            ).toEqual(['ReachesIntoApp'])
          }
        ),
        { numRuns: numRunsFor({ base: 30 }) }
      )
    })

    it("is closed to another app's runtime dependencies but open to its tests", () => {
      fc.assert(
        fc.property(stemArbitrary, kindArbitrary, (app, kind) => {
          const insideApp = packageAt(`${app}-thing`, `apps/${app}/${app}-thing`)
          const otherApp = packageAt('other-thing', `apps/${app}-other/other-thing`)
          expect(
            tagsOf(packageGraphViolations([dependingOn(otherApp, insideApp, kind), insideApp]))
          ).toEqual(kind === 'runtime' ? ['ReachesIntoApp'] : [])
        }),
        { numRuns: numRunsFor({ base: 30 }) }
      )
    })

    it("is open to the site assembly for an app's -web entry only", () => {
      const site = packageAt('wildflower-site-web', 'apps/wildflower-site/wildflower-site-web')
      const entry = packageAt('lifting-web', 'apps/lifting/lifting-web')
      const core = packageAt('lifting-core-js', 'apps/lifting/lifting-core-js')
      expect(
        packageGraphViolations([dependingOn(site, entry, 'runtime'), entry]).map(formatViolation)
      ).toEqual([])
      expect(
        packageGraphViolations([dependingOn(site, core, 'runtime'), core]).map(formatViolation)
      ).toEqual([
        'wildflower-site-web (apps/wildflower-site/wildflower-site-web) depends on lifting-core-js, which is private to apps/lifting/',
      ])
    })
  })

  describe('cycles', () => {
    it('flags two packages depending on each other, of any kind', () => {
      fc.assert(
        fc.property(kindArbitrary, kindArbitrary, (there, back) => {
          const a = packageAt('a', 'slices/a')
          const b = packageAt('b', 'slices/b')
          expect(
            packageGraphViolations([dependingOn(a, b, there), dependingOn(b, a, back)])
          ).toEqual([{ _tag: 'Cycle', ecosystem: 'npm', names: ['a', 'b'] }])
        }),
        { numRuns: numRunsFor({ base: 10 }) }
      )
    })

    it('ignores a package depending on itself', () => {
      fc.assert(
        fc.property(kindArbitrary, (kind) => {
          const crate = packageAt('server-core', 'apps/host/server-core', 'cargo')
          expect(packageGraphViolations([dependingOn(crate, crate, kind)])).toEqual([])
        }),
        { numRuns: numRunsFor({ base: 10 }) }
      )
    })

    it('keeps a TS package and a crate of the same name apart', () => {
      const tsA = packageAt('a', 'slices/a', 'npm')
      const tsB = packageAt('b', 'slices/b', 'npm')
      const crateA = packageAt('a', 'slices/a-rust', 'cargo')
      const crateB = packageAt('b', 'slices/b-rust', 'cargo')
      expect(
        packageGraphViolations([
          dependingOn(tsA, tsB, 'runtime'),
          tsB,
          crateA,
          dependingOn(crateB, crateA, 'runtime'),
        ])
      ).toEqual([])
    })
  })
})
