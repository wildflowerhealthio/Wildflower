import { Option } from 'effect'
import * as fc from 'fast-check'

import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { LabeledResource } from './file-importer-descriptor.ts'

import * as Review from './review.ts'

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
// Review.initial
// ---------------------------------------------------------------------------

describe('Review.initial', () => {
  it('should return an empty selection with no exclusions and no overrides', () => {
    const selection = Review.initial<string>()

    expect(selection.excludedResources.size).toBe(0)
    expect(selection.resourceOverrides.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Review.isResourceIncluded
// ---------------------------------------------------------------------------

describe('Review.isResourceIncluded', () => {
  it('should return true for a key not in excludedResources', () => {
    const selection = Review.initial<string>()

    expect(Review.isResourceIncluded(selection, 'a')).toBe(true)
    expect(Review.isResourceIncluded(selection, 'anything')).toBe(true)
  })

  it('should return false for a key in excludedResources', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'a')

    expect(Review.isResourceIncluded(selection, 'a')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Review.toggleResource
// ---------------------------------------------------------------------------

describe('Review.toggleResource', () => {
  it('should exclude an included resource', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'a')

    expect(selection.excludedResources.has('a')).toBe(true)
  })

  it('should re-include an excluded resource', () => {
    const once = Review.toggleResource(Review.initial<string>(), 'a')
    const twice = Review.toggleResource(once, 'a')

    expect(twice.excludedResources.has('a')).toBe(false)
  })

  it('should not disturb other keys when toggling one', () => {
    const s1 = Review.toggleResource(Review.initial<string>(), 'a')
    const s2 = Review.toggleResource(s1, 'b')

    expect(s2.excludedResources.has('a')).toBe(true)
    expect(s2.excludedResources.has('b')).toBe(true)
  })

  it('should preserve resourceOverrides across toggles', () => {
    const edited = Review.edit(Review.initial<string>(), 'a', 'edited-alpha')
    const toggled = Review.toggleResource(edited, 'b')

    expect(toggled.resourceOverrides.get('a')).toBe('edited-alpha')
  })

  it('should be self-inverse for any key (property)', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const initial = Review.initial<string>()
        const toggled = Review.toggleResource(Review.toggleResource(initial, key), key)
        expect(toggled.excludedResources.size).toBe(0)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// Review.setResourcesIncluded
// ---------------------------------------------------------------------------

describe('Review.setResourcesIncluded', () => {
  it('should exclude every listed key when included is false', () => {
    const selection = Review.setResourcesIncluded(Review.initial<string>(), ['a', 'b'], false)

    expect(Review.excludedCount(threeLabeled, selection)).toBe(2)
    expect(Review.isResourceIncluded(selection, 'a')).toBe(false)
    expect(Review.isResourceIncluded(selection, 'b')).toBe(false)
    expect(Review.isResourceIncluded(selection, 'c')).toBe(true)
  })

  it('should re-include every listed key when included is true', () => {
    const excluded = Review.setResourcesIncluded(Review.initial<string>(), ['a', 'b', 'c'], false)
    const reincluded = Review.setResourcesIncluded(excluded, ['a', 'b'], true)

    expect(Review.isResourceIncluded(reincluded, 'a')).toBe(true)
    expect(Review.isResourceIncluded(reincluded, 'b')).toBe(true)
    expect(Review.isResourceIncluded(reincluded, 'c')).toBe(false)
  })

  it('should leave keys outside the batch untouched', () => {
    const start = Review.toggleResource(Review.initial<string>(), 'c')
    const next = Review.setResourcesIncluded(start, ['a'], false)

    expect(Review.isResourceIncluded(next, 'c')).toBe(false)
  })

  it('should preserve resourceOverrides across the batch change', () => {
    const edited = Review.edit(Review.initial<string>(), 'a', 'edited-alpha')
    const next = Review.setResourcesIncluded(edited, ['a', 'b'], false)

    expect(next.resourceOverrides.get('a')).toBe('edited-alpha')
  })

  it('property: excluding then re-including the same keys restores inclusion', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (keys) => {
        const excluded = Review.setResourcesIncluded(Review.initial<string>(), keys, false)
        const reincluded = Review.setResourcesIncluded(excluded, keys, true)
        for (const key of keys) expect(Review.isResourceIncluded(reincluded, key)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// Review.edit / Review.isResourceEdited / Review.editedResource
// ---------------------------------------------------------------------------

describe('Review.edit', () => {
  it('should set an override for the given key', () => {
    const selection = Review.edit(Review.initial<string>(), 'a', 'edited')

    expect(Review.isResourceEdited(selection, 'a')).toBe(true)
    expect(Option.getOrThrow(Review.editedResource(selection, 'a'))).toBe('edited')
  })

  it('should overwrite a previous edit at the same key', () => {
    const s1 = Review.edit(Review.initial<string>(), 'a', 'first')
    const s2 = Review.edit(s1, 'a', 'second')

    expect(Option.getOrThrow(Review.editedResource(s2, 'a'))).toBe('second')
  })

  it('should not affect other keys', () => {
    const selection = Review.edit(Review.initial<string>(), 'a', 'edited')

    expect(Review.isResourceEdited(selection, 'b')).toBe(false)
    expect(Option.isNone(Review.editedResource(selection, 'b'))).toBe(true)
  })

  it('should preserve excludedResources across edits', () => {
    const toggled = Review.toggleResource(Review.initial<string>(), 'b')
    const edited = Review.edit(toggled, 'a', 'edited')

    expect(edited.excludedResources.has('b')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Review.revert
// ---------------------------------------------------------------------------

describe('Review.revert', () => {
  it('should remove an edit override', () => {
    const edited = Review.edit(Review.initial<string>(), 'a', 'edited')
    const reverted = Review.revert(edited, 'a')

    expect(Review.isResourceEdited(reverted, 'a')).toBe(false)
    expect(Option.isNone(Review.editedResource(reverted, 'a'))).toBe(true)
  })

  it('should be a no-op (same reference) when the key was never edited', () => {
    const initial = Review.initial<string>()
    const reverted = Review.revert(initial, 'a')

    expect(reverted).toBe(initial)
  })

  it('should not disturb edits at other keys', () => {
    const edited = Review.edit(Review.edit(Review.initial<string>(), 'a', 'A*'), 'b', 'B*')
    const reverted = Review.revert(edited, 'a')

    expect(Review.isResourceEdited(reverted, 'a')).toBe(false)
    expect(Review.isResourceEdited(reverted, 'b')).toBe(true)
    expect(Option.getOrThrow(Review.editedResource(reverted, 'b'))).toBe('B*')
  })
})

// ---------------------------------------------------------------------------
// Review.isResourceEdited
// ---------------------------------------------------------------------------

describe('Review.isResourceEdited', () => {
  it('should return false for an initial selection', () => {
    expect(Review.isResourceEdited(Review.initial<string>(), 'any')).toBe(false)
  })

  it('should return true only for keys with an edit override', () => {
    const edited = Review.edit(Review.initial<string>(), 'x', 'X*')

    expect(Review.isResourceEdited(edited, 'x')).toBe(true)
    expect(Review.isResourceEdited(edited, 'y')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Review.editedResource
// ---------------------------------------------------------------------------

describe('Review.editedResource', () => {
  it('should return None for an unedited key', () => {
    expect(Option.isNone(Review.editedResource(Review.initial<string>(), 'a'))).toBe(true)
  })

  it('should return Some with the override value for an edited key', () => {
    const edited = Review.edit(Review.initial<string>(), 'a', 'override')

    expect(Option.isSome(Review.editedResource(edited, 'a'))).toBe(true)
    expect(Option.getOrThrow(Review.editedResource(edited, 'a'))).toBe('override')
  })
})

// ---------------------------------------------------------------------------
// Review.chosenResources
// ---------------------------------------------------------------------------

describe('Review.chosenResources', () => {
  it('should return all resources when nothing is excluded or edited', () => {
    const chosen = Review.chosenResources(threeLabeled, Review.initial<string>())

    expect(chosen).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('should drop exactly the excluded resource', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'b')
    const chosen = Review.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'gamma'])
  })

  it('should drop multiple excluded resources', () => {
    const selection = Review.toggleResource(
      Review.toggleResource(Review.initial<string>(), 'a'),
      'c'
    )
    const chosen = Review.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['beta'])
  })

  it('should substitute an edit override in place of the original', () => {
    const selection = Review.edit(Review.initial<string>(), 'b', 'BETA')
    const chosen = Review.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'BETA', 'gamma'])
  })

  it('should drop an edited resource when it is also excluded', () => {
    const selection = Review.toggleResource(Review.edit(Review.initial<string>(), 'b', 'BETA'), 'b')
    const chosen = Review.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'gamma'])
  })

  it('should preserve the original order', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'b')
    const chosen = Review.chosenResources(threeLabeled, selection)

    // 'a' before 'c' — the order from `labeled`
    expect(chosen).toEqual(['alpha', 'gamma'])
  })

  it('should return an empty array when all resources are excluded', () => {
    let selection = Review.initial<string>()
    for (const entry of threeLabeled) {
      selection = Review.toggleResource(selection, entry.key)
    }
    const chosen = Review.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual([])
  })

  it('should return an empty array when labeled is empty', () => {
    const chosen = Review.chosenResources([], Review.initial<string>())

    expect(chosen).toEqual([])
  })

  it('should ignore overrides that do not match any labeled key', () => {
    const selection = Review.edit(Review.initial<string>(), 'nonexistent', 'X')
    const chosen = Review.chosenResources(threeLabeled, selection)

    expect(chosen).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('should ignore exclusions that do not match any labeled key', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'nonexistent')
    const chosen = Review.chosenResources(threeLabeled, selection)

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
          let selection = Review.initial<string>()
          const expected: string[] = [...originals]
          for (const [key, value] of edits) {
            selection = Review.edit(selection, key, value)
            const index = keys.indexOf(key)
            if (index !== -1) expected[index] = value
          }
          expect(Review.chosenResources(threeLabeled, selection)).toEqual(expected)
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
          let selection = Review.initial<string>()
          for (const key of toggledKeys) selection = Review.toggleResource(selection, key)
          for (const key of toggledKeys) selection = Review.toggleResource(selection, key)
          expect(Review.chosenResources(threeLabeled, selection)).toEqual([
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
// Review.includedCount
// ---------------------------------------------------------------------------

describe('Review.includedCount', () => {
  it('should equal the number of labeled resources when nothing is excluded', () => {
    expect(Review.includedCount(threeLabeled, Review.initial<string>())).toBe(3)
  })

  it('should decrease by one per exclusion', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'a')

    expect(Review.includedCount(threeLabeled, selection)).toBe(2)
  })

  it('should be zero when every resource is excluded', () => {
    let selection = Review.initial<string>()
    for (const entry of threeLabeled) {
      selection = Review.toggleResource(selection, entry.key)
    }
    expect(Review.includedCount(threeLabeled, selection)).toBe(0)
  })

  it('should be zero for an empty labeled list', () => {
    expect(Review.includedCount([], Review.initial<string>())).toBe(0)
  })

  it('should not be affected by edit overrides (edits change value, not count)', () => {
    const selection = Review.edit(Review.initial<string>(), 'b', 'BETA')

    expect(Review.includedCount(threeLabeled, selection)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Review.excludedCount
// ---------------------------------------------------------------------------

describe('Review.excludedCount', () => {
  it('should be zero when nothing is excluded', () => {
    expect(Review.excludedCount(threeLabeled, Review.initial<string>())).toBe(0)
  })

  it('should count one excluded resource', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'b')

    expect(Review.excludedCount(threeLabeled, selection)).toBe(1)
  })

  it('should equal the labeled length when everything is excluded', () => {
    let selection = Review.initial<string>()
    for (const entry of threeLabeled) {
      selection = Review.toggleResource(selection, entry.key)
    }
    expect(Review.excludedCount(threeLabeled, selection)).toBe(3)
  })

  it('should not count exclusions that do not match any labeled key', () => {
    const selection = Review.toggleResource(Review.initial<string>(), 'nonexistent')

    expect(Review.excludedCount(threeLabeled, selection)).toBe(0)
  })

  it('should satisfy includedCount + excludedCount === labeled.length (property)', () => {
    const keys = ['a', 'b', 'c'] as const

    fc.assert(
      fc.property(fc.subarray([...keys], { minLength: 0, maxLength: keys.length }), (excluded) => {
        let selection = Review.initial<string>()
        for (const key of excluded) {
          selection = Review.toggleResource(selection, key)
        }
        const included = Review.includedCount(threeLabeled, selection)
        const excludedN = Review.excludedCount(threeLabeled, selection)
        expect(included + excludedN).toBe(threeLabeled.length)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})
