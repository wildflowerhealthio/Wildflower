import { Option, Schema } from 'effect'
import * as fc from 'fast-check'

import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import * as StagedImport from './staged-import.ts'

/**
 * The per-resource review model is pure selection state — no DOM, no framework —
 * so it is driven directly: a pool of labeled resources, the `Selection`
 * transitions, and the derived read-accessors.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal `FhirResource` — a `Patient` needs nothing but `resourceType` — keyed by `id`. */
const resource = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id })

/** No resource is out by default. */
const NONE_BY_DEFAULT: ReadonlySet<string> = new Set()

// ---------------------------------------------------------------------------
// StagedImport.initial
// ---------------------------------------------------------------------------

describe('StagedImport.initial', () => {
  it('should return an empty selection with no reviewer choices and no overrides', () => {
    expect(StagedImport.initial()).toEqual({
      includedByReviewer: new Map(),
      resourceOverrides: new Map(),
    })
  })
})

// ---------------------------------------------------------------------------
// StagedImport.isResourceIncluded
// ---------------------------------------------------------------------------

describe('StagedImport.isResourceIncluded', () => {
  it('should take the default for a key the reviewer made no choice for', () => {
    const selection = StagedImport.initial()

    expect(StagedImport.isResourceIncluded(selection, NONE_BY_DEFAULT, 'a')).toBe(true)
    expect(StagedImport.isResourceIncluded(selection, new Set(['a']), 'a')).toBe(false)
  })

  it("should take the reviewer's choice over the default either way", () => {
    const ticked = StagedImport.setResourcesIncluded(StagedImport.initial(), ['a'], true)
    const unticked = StagedImport.setResourcesIncluded(StagedImport.initial(), ['a'], false)

    expect(StagedImport.isResourceIncluded(ticked, new Set(['a']), 'a')).toBe(true)
    expect(StagedImport.isResourceIncluded(unticked, NONE_BY_DEFAULT, 'a')).toBe(false)
  })

  it('property: a key with no choice is included exactly when the default does not exclude it', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (key, excluded) => {
        const excludedByDefault = excluded ? new Set([key]) : NONE_BY_DEFAULT
        expect(
          StagedImport.isResourceIncluded(StagedImport.initial(), excludedByDefault, key)
        ).toBe(!excluded)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// StagedImport.toggleResource
// ---------------------------------------------------------------------------

describe('StagedImport.toggleResource', () => {
  it('should record an exclusion for a resource included by default', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'a')

    expect(selection.includedByReviewer).toEqual(new Map([['a', false]]))
  })

  it('should record an inclusion for a resource excluded by default', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial(), new Set(['a']), 'a')

    expect(selection.includedByReviewer).toEqual(new Map([['a', true]]))
  })

  it('should not disturb other keys when toggling one', () => {
    const s1 = StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'a')
    const s2 = StagedImport.toggleResource(s1, NONE_BY_DEFAULT, 'b')

    expect(s2.includedByReviewer).toEqual(
      new Map([
        ['a', false],
        ['b', false],
      ])
    )
  })

  it('should preserve resourceOverrides across toggles', () => {
    const edited = StagedImport.edit(StagedImport.initial(), 'a', resource('edited-alpha'))
    const toggled = StagedImport.toggleResource(edited, NONE_BY_DEFAULT, 'b')

    expect(toggled.resourceOverrides.get('a')).toEqual(resource('edited-alpha'))
  })

  it('property: toggling twice restores whether the key is included, whatever the default', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (key, excluded) => {
        const excludedByDefault = excluded ? new Set([key]) : NONE_BY_DEFAULT
        const toggled = StagedImport.toggleResource(
          StagedImport.toggleResource(StagedImport.initial(), excludedByDefault, key),
          excludedByDefault,
          key
        )
        expect(StagedImport.isResourceIncluded(toggled, excludedByDefault, key)).toBe(!excluded)
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
    const selection = StagedImport.setResourcesIncluded(StagedImport.initial(), ['a', 'b'], false)

    expect(StagedImport.isResourceIncluded(selection, NONE_BY_DEFAULT, 'a')).toBe(false)
    expect(StagedImport.isResourceIncluded(selection, NONE_BY_DEFAULT, 'b')).toBe(false)
    expect(StagedImport.isResourceIncluded(selection, NONE_BY_DEFAULT, 'c')).toBe(true)
  })

  it('should re-include every listed key when included is true', () => {
    const excluded = StagedImport.setResourcesIncluded(
      StagedImport.initial(),
      ['a', 'b', 'c'],
      false
    )
    const reincluded = StagedImport.setResourcesIncluded(excluded, ['a', 'b'], true)

    expect(StagedImport.isResourceIncluded(reincluded, NONE_BY_DEFAULT, 'a')).toBe(true)
    expect(StagedImport.isResourceIncluded(reincluded, NONE_BY_DEFAULT, 'b')).toBe(true)
    expect(StagedImport.isResourceIncluded(reincluded, NONE_BY_DEFAULT, 'c')).toBe(false)
  })

  it('should leave keys outside the batch untouched', () => {
    const start = StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'c')
    const next = StagedImport.setResourcesIncluded(start, ['a'], false)

    expect(StagedImport.isResourceIncluded(next, NONE_BY_DEFAULT, 'c')).toBe(false)
  })

  it('should preserve resourceOverrides across the batch change', () => {
    const edited = StagedImport.edit(StagedImport.initial(), 'a', resource('edited-alpha'))
    const next = StagedImport.setResourcesIncluded(edited, ['a', 'b'], false)

    expect(next.resourceOverrides.get('a')).toEqual(resource('edited-alpha'))
  })

  it('property: the listed keys are included as asked, whatever the default', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.boolean(), (keys, included) => {
        const excludedByDefault = new Set(keys)
        const next = StagedImport.setResourcesIncluded(StagedImport.initial(), keys, included)
        for (const key of keys) {
          expect(StagedImport.isResourceIncluded(next, excludedByDefault, key)).toBe(included)
        }
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
    const selection = StagedImport.edit(StagedImport.initial(), 'a', resource('edited'))

    expect(StagedImport.isResourceEdited(selection, 'a')).toBe(true)
    expect(Option.getOrThrow(StagedImport.editedResource(selection, 'a'))).toEqual(
      resource('edited')
    )
  })

  it('should overwrite a previous edit at the same key', () => {
    const s1 = StagedImport.edit(StagedImport.initial(), 'a', resource('first'))
    const s2 = StagedImport.edit(s1, 'a', resource('second'))

    expect(Option.getOrThrow(StagedImport.editedResource(s2, 'a'))).toEqual(resource('second'))
  })

  it('should not affect other keys', () => {
    const selection = StagedImport.edit(StagedImport.initial(), 'a', resource('edited'))

    expect(StagedImport.isResourceEdited(selection, 'b')).toBe(false)
    expect(Option.isNone(StagedImport.editedResource(selection, 'b'))).toBe(true)
  })

  it("should preserve the reviewer's include/exclude choices across edits", () => {
    const toggled = StagedImport.toggleResource(StagedImport.initial(), NONE_BY_DEFAULT, 'b')
    const edited = StagedImport.edit(toggled, 'a', resource('edited'))

    expect(edited.includedByReviewer).toEqual(new Map([['b', false]]))
  })
})

// ---------------------------------------------------------------------------
// StagedImport.revert
// ---------------------------------------------------------------------------

describe('StagedImport.revert', () => {
  it('should remove an edit override', () => {
    const edited = StagedImport.edit(StagedImport.initial(), 'a', resource('edited'))
    const reverted = StagedImport.revert(edited, 'a')

    expect(StagedImport.isResourceEdited(reverted, 'a')).toBe(false)
    expect(Option.isNone(StagedImport.editedResource(reverted, 'a'))).toBe(true)
  })

  it('should be a no-op (same reference) when the key was never edited', () => {
    const initial = StagedImport.initial()
    const reverted = StagedImport.revert(initial, 'a')

    expect(reverted).toBe(initial)
  })

  it('should not disturb edits at other keys', () => {
    const edited = StagedImport.edit(
      StagedImport.edit(StagedImport.initial(), 'a', resource('A*')),
      'b',
      resource('B*')
    )
    const reverted = StagedImport.revert(edited, 'a')

    expect(StagedImport.isResourceEdited(reverted, 'a')).toBe(false)
    expect(StagedImport.isResourceEdited(reverted, 'b')).toBe(true)
    expect(Option.getOrThrow(StagedImport.editedResource(reverted, 'b'))).toEqual(resource('B*'))
  })
})

// ---------------------------------------------------------------------------
// StagedImport.isResourceEdited
// ---------------------------------------------------------------------------

describe('StagedImport.isResourceEdited', () => {
  it('should return false for an initial selection', () => {
    expect(StagedImport.isResourceEdited(StagedImport.initial(), 'any')).toBe(false)
  })

  it('should return true only for keys with an edit override', () => {
    const edited = StagedImport.edit(StagedImport.initial(), 'x', resource('X*'))

    expect(StagedImport.isResourceEdited(edited, 'x')).toBe(true)
    expect(StagedImport.isResourceEdited(edited, 'y')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.editedResource
// ---------------------------------------------------------------------------

describe('StagedImport.editedResource', () => {
  it('should return None for an unedited key', () => {
    expect(Option.isNone(StagedImport.editedResource(StagedImport.initial(), 'a'))).toBe(true)
  })

  it('should return Some with the override value for an edited key', () => {
    const edited = StagedImport.edit(StagedImport.initial(), 'a', resource('override'))

    expect(Option.isSome(StagedImport.editedResource(edited, 'a'))).toBe(true)
    expect(Option.getOrThrow(StagedImport.editedResource(edited, 'a'))).toEqual(
      resource('override')
    )
  })
})
