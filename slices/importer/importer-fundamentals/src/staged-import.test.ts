import { Option } from 'effect'
import * as fc from 'fast-check'

import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { LabeledResource } from './file-importer-descriptor.ts'

import * as StagedImport from './staged-import.ts'

/**
 * The per-resource review model is pure selection state — no DOM, no framework —
 * so it is driven directly: a pool of labeled resources (string-typed for
 * simplicity), the `Selection` transitions, and the derived read-accessors.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `LabeledResource<string>` from a key and resource value. */
const labeled = (key: string, resource: string, title = key): LabeledResource<string> => ({
  key,
  title,
  resource,
})

/** A standard three-resource pool used across most tests. */
const threeLabeled: readonly LabeledResource<string>[] = [
  labeled('a', 'alpha'),
  labeled('b', 'beta'),
  labeled('c', 'gamma'),
]

// ---------------------------------------------------------------------------
// StagedImport.initial
// ---------------------------------------------------------------------------

describe('StagedImport.initial', () => {
  it('should return an empty selection with no exclusions and no overrides', () => {
    const selection = StagedImport.initial<string>()

    expect(selection.excludedResources.size).toBe(0)
    expect(selection.resourceOverrides.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.isResourceIncluded
// ---------------------------------------------------------------------------

describe('StagedImport.isResourceIncluded', () => {
  it('should return true for a key not in excludedResources', () => {
    const selection = StagedImport.initial<string>()

    expect(StagedImport.isResourceIncluded(selection, 'a')).toBe(true)
    expect(StagedImport.isResourceIncluded(selection, 'anything')).toBe(true)
  })

  it('should return false for a key in excludedResources', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'a')

    expect(StagedImport.isResourceIncluded(selection, 'a')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.toggleResource
// ---------------------------------------------------------------------------

describe('StagedImport.toggleResource', () => {
  it('should exclude an included resource', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'a')

    expect(selection.excludedResources.has('a')).toBe(true)
  })

  it('should re-include an excluded resource', () => {
    const once = StagedImport.toggleResource(StagedImport.initial<string>(), 'a')
    const twice = StagedImport.toggleResource(once, 'a')

    expect(twice.excludedResources.has('a')).toBe(false)
  })

  it('should not disturb other keys when toggling one', () => {
    const s1 = StagedImport.toggleResource(StagedImport.initial<string>(), 'a')
    const s2 = StagedImport.toggleResource(s1, 'b')

    expect(s2.excludedResources.has('a')).toBe(true)
    expect(s2.excludedResources.has('b')).toBe(true)
  })

  it('should preserve resourceOverrides across toggles', () => {
    const edited = StagedImport.edit(StagedImport.initial<string>(), 'a', 'edited-alpha')
    const toggled = StagedImport.toggleResource(edited, 'b')

    expect(toggled.resourceOverrides.get('a')).toBe('edited-alpha')
  })

  it('should be self-inverse for any key (property)', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const initial = StagedImport.initial<string>()
        const toggled = StagedImport.toggleResource(StagedImport.toggleResource(initial, key), key)
        expect(toggled.excludedResources.size).toBe(0)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// StagedImport.setResourcesIncluded
// ---------------------------------------------------------------------------

describe('StagedImport.setResourcesIncluded', () => {
  it('should exclude every listed key when included is false', () => {
    const selection = StagedImport.setResourcesIncluded(
      StagedImport.initial<string>(),
      ['a', 'b'],
      false
    )

    expect(StagedImport.excludedCount(threeLabeled, selection)).toBe(2)
    expect(StagedImport.isResourceIncluded(selection, 'a')).toBe(false)
    expect(StagedImport.isResourceIncluded(selection, 'b')).toBe(false)
    expect(StagedImport.isResourceIncluded(selection, 'c')).toBe(true)
  })

  it('should re-include every listed key when included is true', () => {
    const excluded = StagedImport.setResourcesIncluded(
      StagedImport.initial<string>(),
      ['a', 'b', 'c'],
      false
    )
    const reincluded = StagedImport.setResourcesIncluded(excluded, ['a', 'b'], true)

    expect(StagedImport.isResourceIncluded(reincluded, 'a')).toBe(true)
    expect(StagedImport.isResourceIncluded(reincluded, 'b')).toBe(true)
    expect(StagedImport.isResourceIncluded(reincluded, 'c')).toBe(false)
  })

  it('should leave keys outside the batch untouched', () => {
    const start = StagedImport.toggleResource(StagedImport.initial<string>(), 'c')
    const next = StagedImport.setResourcesIncluded(start, ['a'], false)

    expect(StagedImport.isResourceIncluded(next, 'c')).toBe(false)
  })

  it('should preserve resourceOverrides across the batch change', () => {
    const edited = StagedImport.edit(StagedImport.initial<string>(), 'a', 'edited-alpha')
    const next = StagedImport.setResourcesIncluded(edited, ['a', 'b'], false)

    expect(next.resourceOverrides.get('a')).toBe('edited-alpha')
  })

  it('property: excluding then re-including the same keys restores inclusion', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (keys) => {
        const excluded = StagedImport.setResourcesIncluded(
          StagedImport.initial<string>(),
          keys,
          false
        )
        const reincluded = StagedImport.setResourcesIncluded(excluded, keys, true)
        for (const key of keys) expect(StagedImport.isResourceIncluded(reincluded, key)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// StagedImport.edit / StagedImport.isResourceEdited / StagedImport.editedResource
// ---------------------------------------------------------------------------

describe('StagedImport.edit', () => {
  it('should set an override for the given key', () => {
    const selection = StagedImport.edit(StagedImport.initial<string>(), 'a', 'edited')

    expect(StagedImport.isResourceEdited(selection, 'a')).toBe(true)
    expect(Option.getOrThrow(StagedImport.editedResource(selection, 'a'))).toBe('edited')
  })

  it('should overwrite a previous edit at the same key', () => {
    const s1 = StagedImport.edit(StagedImport.initial<string>(), 'a', 'first')
    const s2 = StagedImport.edit(s1, 'a', 'second')

    expect(Option.getOrThrow(StagedImport.editedResource(s2, 'a'))).toBe('second')
  })

  it('should not affect other keys', () => {
    const selection = StagedImport.edit(StagedImport.initial<string>(), 'a', 'edited')

    expect(StagedImport.isResourceEdited(selection, 'b')).toBe(false)
    expect(Option.isNone(StagedImport.editedResource(selection, 'b'))).toBe(true)
  })

  it('should preserve excludedResources across edits', () => {
    const toggled = StagedImport.toggleResource(StagedImport.initial<string>(), 'b')
    const edited = StagedImport.edit(toggled, 'a', 'edited')

    expect(edited.excludedResources.has('b')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.revert
// ---------------------------------------------------------------------------

describe('StagedImport.revert', () => {
  it('should remove an edit override', () => {
    const edited = StagedImport.edit(StagedImport.initial<string>(), 'a', 'edited')
    const reverted = StagedImport.revert(edited, 'a')

    expect(StagedImport.isResourceEdited(reverted, 'a')).toBe(false)
    expect(Option.isNone(StagedImport.editedResource(reverted, 'a'))).toBe(true)
  })

  it('should be a no-op (same reference) when the key was never edited', () => {
    const initial = StagedImport.initial<string>()
    const reverted = StagedImport.revert(initial, 'a')

    expect(reverted).toBe(initial)
  })

  it('should not disturb edits at other keys', () => {
    const edited = StagedImport.edit(
      StagedImport.edit(StagedImport.initial<string>(), 'a', 'A*'),
      'b',
      'B*'
    )
    const reverted = StagedImport.revert(edited, 'a')

    expect(StagedImport.isResourceEdited(reverted, 'a')).toBe(false)
    expect(StagedImport.isResourceEdited(reverted, 'b')).toBe(true)
    expect(Option.getOrThrow(StagedImport.editedResource(reverted, 'b'))).toBe('B*')
  })
})

// ---------------------------------------------------------------------------
// StagedImport.isResourceEdited
// ---------------------------------------------------------------------------

describe('StagedImport.isResourceEdited', () => {
  it('should return false for an initial selection', () => {
    expect(StagedImport.isResourceEdited(StagedImport.initial<string>(), 'any')).toBe(false)
  })

  it('should return true only for keys with an edit override', () => {
    const edited = StagedImport.edit(StagedImport.initial<string>(), 'x', 'X*')

    expect(StagedImport.isResourceEdited(edited, 'x')).toBe(true)
    expect(StagedImport.isResourceEdited(edited, 'y')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.editedResource
// ---------------------------------------------------------------------------

describe('StagedImport.editedResource', () => {
  it('should return None for an unedited key', () => {
    expect(Option.isNone(StagedImport.editedResource(StagedImport.initial<string>(), 'a'))).toBe(
      true
    )
  })

  it('should return Some with the override value for an edited key', () => {
    const edited = StagedImport.edit(StagedImport.initial<string>(), 'a', 'override')

    expect(Option.isSome(StagedImport.editedResource(edited, 'a'))).toBe(true)
    expect(Option.getOrThrow(StagedImport.editedResource(edited, 'a'))).toBe('override')
  })
})

// ---------------------------------------------------------------------------
// StagedImport.chosenResources
// ---------------------------------------------------------------------------

describe('StagedImport.chosenResources', () => {
  it('should return all resources when nothing is excluded or edited', () => {
    const chosen = StagedImport.chosenResources(threeLabeled, StagedImport.initial<string>())

    expect(chosen).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('should drop exactly the excluded resource', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'b')
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'gamma'])
  })

  it('should drop multiple excluded resources', () => {
    const selection = StagedImport.toggleResource(
      StagedImport.toggleResource(StagedImport.initial<string>(), 'a'),
      'c'
    )
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['beta'])
  })

  it('should substitute an edit override in place of the original', () => {
    const selection = StagedImport.edit(StagedImport.initial<string>(), 'b', 'BETA')
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'BETA', 'gamma'])
  })

  it('should drop an edited resource when it is also excluded', () => {
    const selection = StagedImport.toggleResource(
      StagedImport.edit(StagedImport.initial<string>(), 'b', 'BETA'),
      'b'
    )
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'gamma'])
  })

  it('should preserve the original order', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'b')
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    // 'a' before 'c' — the order from `labeled`
    expect(chosen).toEqual(['alpha', 'gamma'])
  })

  it('should return an empty array when all resources are excluded', () => {
    let selection = StagedImport.initial<string>()
    for (const entry of threeLabeled) {
      selection = StagedImport.toggleResource(selection, entry.key)
    }
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual([])
  })

  it('should return an empty array when labeled is empty', () => {
    const chosen = StagedImport.chosenResources([], StagedImport.initial<string>())

    expect(chosen).toEqual([])
  })

  it('should ignore overrides that do not match any labeled key', () => {
    const selection = StagedImport.edit(StagedImport.initial<string>(), 'nonexistent', 'X')
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('should ignore exclusions that do not match any labeled key', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'nonexistent')
    const chosen = StagedImport.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('should reflect exactly the last edit per key under any sequence of edits (property)', () => {
    const keys = ['a', 'b', 'c'] as const
    const originals = ['alpha', 'beta', 'gamma'] as const

    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...keys), fc.string()), {
          minLength: 0,
          maxLength: 16,
        }),
        (edits) => {
          let selection = StagedImport.initial<string>()
          const expected: string[] = [...originals]
          for (const [key, value] of edits) {
            selection = StagedImport.edit(selection, key, value)
            const index = keys.indexOf(key)
            if (index !== -1) expected[index] = value
          }
          expect(StagedImport.chosenResources(threeLabeled, selection)).toEqual(expected)
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('should equal the initial set under any sequence of self-cancelling toggles (property)', () => {
    const keys = ['a', 'b', 'c'] as const

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...keys), { minLength: 0, maxLength: 8 }),
        (toggledKeys) => {
          // Toggle twice per key — the outcome is a no-op.
          let selection = StagedImport.initial<string>()
          for (const key of toggledKeys) selection = StagedImport.toggleResource(selection, key)
          for (const key of toggledKeys) selection = StagedImport.toggleResource(selection, key)
          expect(StagedImport.chosenResources(threeLabeled, selection)).toEqual([
            'alpha',
            'beta',
            'gamma',
          ])
        }
      ),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// StagedImport.includedCount
// ---------------------------------------------------------------------------

describe('StagedImport.includedCount', () => {
  it('should equal the number of labeled resources when nothing is excluded', () => {
    expect(StagedImport.includedCount(threeLabeled, StagedImport.initial<string>())).toBe(3)
  })

  it('should decrease by one per exclusion', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'a')

    expect(StagedImport.includedCount(threeLabeled, selection)).toBe(2)
  })

  it('should be zero when every resource is excluded', () => {
    let selection = StagedImport.initial<string>()
    for (const entry of threeLabeled) {
      selection = StagedImport.toggleResource(selection, entry.key)
    }
    expect(StagedImport.includedCount(threeLabeled, selection)).toBe(0)
  })

  it('should be zero for an empty labeled list', () => {
    expect(StagedImport.includedCount([], StagedImport.initial<string>())).toBe(0)
  })

  it('should not be affected by edit overrides (edits change value, not count)', () => {
    const selection = StagedImport.edit(StagedImport.initial<string>(), 'b', 'BETA')

    expect(StagedImport.includedCount(threeLabeled, selection)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.excludedCount
// ---------------------------------------------------------------------------

describe('StagedImport.excludedCount', () => {
  it('should be zero when nothing is excluded', () => {
    expect(StagedImport.excludedCount(threeLabeled, StagedImport.initial<string>())).toBe(0)
  })

  it('should count one excluded resource', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'b')

    expect(StagedImport.excludedCount(threeLabeled, selection)).toBe(1)
  })

  it('should equal the labeled length when everything is excluded', () => {
    let selection = StagedImport.initial<string>()
    for (const entry of threeLabeled) {
      selection = StagedImport.toggleResource(selection, entry.key)
    }
    expect(StagedImport.excludedCount(threeLabeled, selection)).toBe(3)
  })

  it('should not count exclusions that do not match any labeled key', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial<string>(), 'nonexistent')

    expect(StagedImport.excludedCount(threeLabeled, selection)).toBe(0)
  })

  it('should satisfy includedCount + excludedCount === labeled.length (property)', () => {
    const keys = ['a', 'b', 'c'] as const

    fc.assert(
      fc.property(fc.subarray([...keys], { minLength: 0, maxLength: keys.length }), (excluded) => {
        let selection = StagedImport.initial<string>()
        for (const key of excluded) {
          selection = StagedImport.toggleResource(selection, key)
        }
        const included = StagedImport.includedCount(threeLabeled, selection)
        const excludedN = StagedImport.excludedCount(threeLabeled, selection)
        expect(included + excludedN).toBe(threeLabeled.length)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})
