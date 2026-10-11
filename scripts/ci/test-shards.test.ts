import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { areaOf, loadVitestProjects, planShards } from './test-shards.ts'
import type { VitestProject } from './test-shards.ts'

// scripts/ci/ sits two levels under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A project root path segment: what a workspace folder name looks like. */
const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/)

const projectUnder = (top: fc.Arbitrary<string>): fc.Arbitrary<VitestProject> =>
  fc
    .tuple(top, fc.array(segment, { minLength: 1, maxLength: 4 }), segment)
    .map(([head, rest, name]) => ({
      name: `${head}-${rest.join('-')}-${name}`,
      root: [head, ...rest].join('/'),
    }))

const claimedTop = fc.constantFrom('apps', 'global', 'scripts', 'slices')

/** The project names in `shards`, one entry per area (split parts counted once). */
const projectsPerArea = (
  shards: readonly { readonly name: string; readonly projects: readonly string[] }[]
): readonly string[] => {
  const byArea = new Map<string, readonly string[]>()
  for (const shard of shards) byArea.set(shard.name.split(' ')[0] ?? shard.name, shard.projects)
  return [...byArea.values()].flat()
}

describe('test-shards / areaOf', () => {
  it('gives every apps/<folder> descendant that folder as its area', () => {
    fc.assert(
      fc.property(segment, fc.array(segment, { maxLength: 4 }), (folder, rest) => {
        expect(areaOf(['apps', folder, ...rest].join('/'))).toEqual(Either.right(`apps/${folder}`))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('gives every global/scripts/slices descendant its top-level directory', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('global', 'scripts', 'slices'),
        fc.array(segment, { maxLength: 4 }),
        (top, rest) => {
          expect(areaOf([top, ...rest].join('/'))).toEqual(Either.right(top))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('claims no root outside those directories, nor bare apps/', () => {
    const unclaimedTop = segment.filter((s) => !['apps', 'global', 'scripts', 'slices'].includes(s))
    fc.assert(
      fc.property(unclaimedTop, fc.array(segment, { maxLength: 4 }), (top, rest) => {
        const root = [top, ...rest].join('/')
        expect(areaOf(root)).toEqual(Either.left(root))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
    expect(areaOf('apps')).toEqual(Either.left('apps'))
    expect(areaOf('')).toEqual(Either.left(''))
  })
})

describe('test-shards / planShards', () => {
  it('runs every claimed project in exactly one area', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(projectUnder(claimedTop), { selector: (p) => p.name, maxLength: 30 }),
        (projects) => {
          const shards = Either.getOrThrow(planShards(projects))
          expect(projectsPerArea(shards).toSorted()).toEqual(projects.map((p) => p.name).toSorted())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('fails on, rather than drops, a project no area claims', () => {
    const result = planShards([
      { name: 'kept', root: 'apps/relay/relay-core-js' },
      { name: 'stray', root: 'tools/stray' },
    ])
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.roots).toEqual(['tools/stray'])
  })

  it('splits slices into two --shard parts over the same projects', () => {
    const projects = [
      { name: 'b', root: 'slices/fhir/fhir-r4' },
      { name: 'a', root: 'slices/dicom/dicom' },
    ]
    expect(Either.getOrThrow(planShards(projects))).toEqual([
      { name: 'slices 1/2', projects: ['a', 'b'], vitestShard: '1/2' },
      { name: 'slices 2/2', projects: ['a', 'b'], vitestShard: '2/2' },
    ])
  })
})

describe('test-shards / the workspace', () => {
  it('partitions every real Vitest project into the shards', async () => {
    const projects = await Effect.runPromise(loadVitestProjects(repoRoot))
    const shards = Either.getOrThrow(planShards(projects))
    const names = projects.map((p) => p.name)
    // Every project in exactly one area, none dropped, none invented.
    expect(projectsPerArea(shards).toSorted()).toEqual(names.toSorted())
    // A new apps/<folder> gets its own shard with no edit to the script.
    expect(shards.map((s) => s.name)).toEqual(
      expect.arrayContaining(['global', 'scripts', 'slices 1/2', 'slices 2/2', 'apps/relay'])
    )
  }, 60_000)
})
