import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  cratesFromMetadata,
  cratesReading,
  planShards,
  selectionFor,
  ShardDefinitionError,
  SHARDS,
  withDependents,
} from './rust-shards.ts'
import type { Crate, ShardDefinition } from './rust-shards.ts'

const crate = (name: string, dir: string, pathDeps: readonly string[] = []): Crate => ({
  name,
  dir,
  pathDeps,
})

// A shared leaf two servers build on, a host crate on top, and a relay nothing
// but the host depends on — the shape of the real workspace, in miniature.
const crates = [
  crate('shared', 'slices/shared-rust'),
  crate('auth', 'apps/host/auth-rust', ['shared']),
  crate('server', 'apps/host/server-rust', ['auth', 'shared']),
  crate('relay', 'apps/relay/relay-server', ['shared']),
  crate('servers', 'apps/host/servers/servers-rust', ['server', 'relay']),
  crate('servers-tauri', 'apps/host/servers/servers-tauri', ['servers']),
]

const shards: readonly ShardDefinition[] = [
  { name: 'auth', crates: ['auth', 'shared'] },
  { name: 'server', crates: ['server'] },
  { name: 'host', crates: ['servers', 'servers-tauri'] },
  { name: 'relay', crates: ['relay'] },
]

const shardsFor = (changed: readonly string[]): readonly string[] =>
  planShards(shards, crates, selectionFor(changed, crates)).map((s) => s.name)

describe('rust-shards / cratesFromMetadata', () => {
  it('matches path deps by directory, drops registry deps, and dedupes', () => {
    const parsed = cratesFromMetadata({
      workspace_root: '/repo',
      packages: [
        { name: 'a', manifest_path: '/repo/x/a/Cargo.toml', dependencies: [] },
        {
          name: 'b',
          manifest_path: '/repo/y/b/Cargo.toml',
          dependencies: [
            // A renamed path dep surfaces its alias; the path names the crate.
            { name: 'alias', path: '/repo/x/a' },
            { name: 'a', path: '/repo/x/a' },
            { name: 'serde' },
          ],
        },
      ],
    })
    expect(parsed).toEqual([crate('a', 'x/a'), crate('b', 'y/b', ['a'])])
  })
})

describe('rust-shards / withDependents', () => {
  it('reaches exactly the crates with a path-dep chain to the seed', () => {
    fc.assert(
      fc.property(fc.subarray(crates.map((c) => c.name)), (seed) => {
        const reached = withDependents(new Set(seed), crates)
        const dependsOnSeed = (name: string): boolean =>
          seed.includes(name) ||
          (crates.find((c) => c.name === name)?.pathDeps ?? []).some(dependsOnSeed)
        for (const c of crates) expect(reached.has(c.name)).toBe(dependsOnSeed(c.name))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('rust-shards / cratesReading', () => {
  it('gives a file inside a crate that crate, the deepest one when nested', () => {
    const nested = [...crates, crate('inner', 'apps/host/auth-rust/inner')]
    expect(cratesReading('apps/host/auth-rust/src/lib.rs', nested)).toEqual(['auth'])
    expect(cratesReading('apps/host/auth-rust/inner/src/lib.rs', nested)).toEqual(['inner'])
  })

  it('gives a file beside crate directories every crate under its directory', () => {
    expect(cratesReading('apps/host/servers/servers-wire-golden.json', crates)).toEqual([
      'servers',
      'servers-tauri',
    ])
  })

  it('adds the crates reading a file from outside to the crates beside it', () => {
    const withRecorder = [
      ...crates,
      crate('wildflowerhealthio-recorder', 'apps/host/recorder/recorder-rust'),
      crate('wildflowerhealthio-recorder-tauri', 'apps/host/recorder/recorder-tauri'),
      crate('wildflowerhealthio-browser-sniffer-tauri', 'apps/host/browser-sniffer-tauri'),
    ]
    expect(cratesReading('apps/host/recorder/recorder-wire-golden.json', withRecorder)).toEqual([
      'wildflowerhealthio-recorder',
      'wildflowerhealthio-recorder-tauri',
      'wildflowerhealthio-browser-sniffer-tauri',
    ])
  })

  it('gives files no crate reads nothing, the repo root included', () => {
    for (const file of [
      'apps/launcher/src/index.ts',
      'apps/host/servers/servers-js/src/index.ts',
      'README.md',
    ]) {
      expect(cratesReading(file, crates)).toEqual([])
    }
  })
})

describe('rust-shards / selectionFor + planShards', () => {
  it("runs a changed crate's shard and its dependers' shards", () => {
    expect(shardsFor(['apps/host/auth-rust/src/lib.rs'])).toEqual(['auth', 'server', 'host'])
  })

  it('runs only the changed leaf shard when only it depends on itself', () => {
    expect(shardsFor(['apps/host/servers/servers-tauri/src/lib.rs'])).toEqual(['host'])
  })

  it('runs no shard for changes no crate reads', () => {
    expect(shardsFor(['apps/launcher/src/index.ts', 'docs/Rust/Notes.md'])).toEqual([])
  })

  it('runs every shard for a toolchain, lockfile, manifest or CI plumbing change', () => {
    for (const file of [
      'Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      'scripts/checks/rust.sh',
      '.github/workflows/ci-rust.yml',
      '.github/actions/setup-tauri-linux-deps/action.yml',
    ]) {
      expect(shardsFor([file])).toEqual(['auth', 'server', 'host', 'relay'])
    }
  })

  it('selects every shard whose crates the selection touches, in definition order', () => {
    fc.assert(
      fc.property(fc.subarray(crates.map((c) => c.name)), (affected) => {
        const planned = planShards(shards, crates, {
          _tag: 'AffectedCrates',
          crates: new Set(affected),
        }).map((s) => s.name)
        const expected = shards
          .filter((s) => s.crates.some((name) => affected.includes(name)))
          .map((s) => s.name)
        expect(planned).toEqual(expected)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it("filters each shard to exactly its crates' packages", () => {
    expect(planShards(shards, crates, { _tag: 'AllShards', reason: 'test' })[0]).toEqual({
      name: 'auth',
      filter: 'package(=auth) | package(=shared)',
    })
  })

  it('fails on a crate in no shard, an unknown crate, or a crate in two', () => {
    const none = { _tag: 'AffectedCrates', crates: new Set<string>() } as const
    expect(() => planShards(shards.slice(1), crates, none)).toThrow(ShardDefinitionError)
    expect(() =>
      planShards([...shards, { name: 'ghost', crates: ['ghost'] }], crates, none)
    ).toThrow(/not in the workspace: ghost/)
    expect(() =>
      planShards([...shards, { name: 'again', crates: ['relay'] }], crates, none)
    ).toThrow(/in more than one shard: relay/)
  })
})

describe('rust-shards / SHARDS', () => {
  it('lists each crate once', () => {
    const listed = SHARDS.flatMap((s) => s.crates)
    expect(new Set(listed).size).toBe(listed.length)
  })
})
