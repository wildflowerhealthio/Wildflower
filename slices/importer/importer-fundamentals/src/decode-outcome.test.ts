import * as fc from 'fast-check'

import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { DecodedFile, LabeledResource } from './file-importer-descriptor.ts'

import { fromSingleFileDecode, type SingleFileDecode, type WriteSet } from './decode-outcome.ts'
import * as StagedImport from './staged-import.ts'

/**
 * The decode-outcome derivation is pure: a file's decode outcome plus a
 * selection → either "resources to write" or "skip." No DOM, no framework, no
 * services.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const labeled = (key: string, resource: string, title = key): LabeledResource<string> => ({
  key,
  title,
  resource,
})

const decoded = (resources: readonly LabeledResource<string>[]): DecodedFile<string> => ({
  sections: [{ title: 'Test', resources }],
  notes: [],
})

const readFile = (resources: readonly LabeledResource<string>[]): SingleFileDecode<string> => ({
  _tag: 'read',
  decoded: decoded(resources),
})

/** Narrow a write set to `resources` or fail the test. */
const expectResources = (
  result: WriteSet<string>
): Extract<WriteSet<string>, { readonly _tag: 'resources' }> => {
  expect(result._tag).toBe('resources')
  if (result._tag !== 'resources') throw new Error('expected resources')
  return result
}

// ---------------------------------------------------------------------------
// Unreadable / unrecognized → skip('unreadable')
// ---------------------------------------------------------------------------

describe('Decode.fromSingleFileDecode — non-read outcomes', () => {
  it('should skip an unreadable file with reason "unreadable"', () => {
    const result = fromSingleFileDecode({ _tag: 'unreadable' }, StagedImport.initial<string>())

    expect(result).toEqual({ _tag: 'skip', reason: 'unreadable' })
  })

  it('should skip an unrecognized file with reason "unreadable"', () => {
    const result = fromSingleFileDecode({ _tag: 'unrecognized' }, StagedImport.initial<string>())

    expect(result).toEqual({ _tag: 'skip', reason: 'unreadable' })
  })
})

// ---------------------------------------------------------------------------
// Read file → resources or skip('nothing')
// ---------------------------------------------------------------------------

describe('Decode.fromSingleFileDecode — read files', () => {
  it('should return all resources when nothing is excluded', () => {
    const resources = [labeled('a', 'alpha'), labeled('b', 'beta')]
    const result = fromSingleFileDecode(readFile(resources), StagedImport.initial<string>())

    const ws = expectResources(result)
    expect(ws.chosen).toEqual([
      { key: 'a', resource: 'alpha' },
      { key: 'b', resource: 'beta' },
    ])
    expect(ws.excluded).toBe(0)
  })

  it('should skip with "nothing" when all resources are excluded', () => {
    const resources = [labeled('a', 'alpha')]
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'a')
    const result = fromSingleFileDecode(readFile(resources), selection)

    expect(result).toEqual({ _tag: 'skip', reason: 'nothing' })
  })

  it('should skip with "nothing" when the file decoded to zero resources', () => {
    const result = fromSingleFileDecode(readFile([]), StagedImport.initial<string>())

    expect(result).toEqual({ _tag: 'skip', reason: 'nothing' })
  })

  it('should drop excluded resources and count them', () => {
    const resources = [labeled('a', 'alpha'), labeled('b', 'beta'), labeled('c', 'gamma')]
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'b')
    const result = fromSingleFileDecode(readFile(resources), selection)

    const ws = expectResources(result)
    expect(ws.chosen.map((e) => e.key)).toEqual(['a', 'c'])
    expect(ws.excluded).toBe(1)
  })

  it('should substitute edit overrides', () => {
    const resources = [labeled('a', 'alpha'), labeled('b', 'beta')]
    const selection = StagedImport.edit(StagedImport.initial<string>(), 'b', 'BETA')
    const result = fromSingleFileDecode(readFile(resources), selection)

    const ws = expectResources(result)
    expect(ws.chosen).toEqual([
      { key: 'a', resource: 'alpha' },
      { key: 'b', resource: 'BETA' },
    ])
  })

  it('should flatten resources across multiple sections', () => {
    const file: SingleFileDecode<string> = {
      _tag: 'read',
      decoded: {
        sections: [
          { title: 'S1', resources: [labeled('a', 'alpha')] },
          { title: 'S2', resources: [labeled('b', 'beta')] },
        ],
        notes: [],
      },
    }
    const result = fromSingleFileDecode(file, StagedImport.initial<string>())

    const ws = expectResources(result)
    expect(ws.chosen.map((e) => e.key)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Property: chosen + excluded = total labeled
// ---------------------------------------------------------------------------

describe('Decode.fromSingleFileDecode — properties', () => {
  it('should satisfy chosen.length + excluded === labeled.length for any read file (property)', () => {
    const keys = ['a', 'b', 'c', 'd']

    fc.assert(
      fc.property(fc.subarray([...keys]), fc.subarray([...keys]), (usedKeys, excludedKeys) => {
        const resources = usedKeys.map((k) => labeled(k, k))
        let selection = StagedImport.initial<string>()
        for (const k of excludedKeys) {
          selection = StagedImport.toggleResource(selection, k)
        }
        const result = fromSingleFileDecode(readFile(resources), selection)

        if (result._tag === 'skip' && result.reason === 'nothing') {
          const includedCount = resources.filter((r) => !excludedKeys.includes(r.key)).length
          expect(includedCount).toBe(0)
        } else if (result._tag === 'resources') {
          expect(result.chosen.length + result.excluded).toBe(resources.length)
        }
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })
})
