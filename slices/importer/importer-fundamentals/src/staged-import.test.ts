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

// ---------------------------------------------------------------------------
// StagedImport.initial
// ---------------------------------------------------------------------------

describe('StagedImport.initial', () => {
  it('should return an empty selection with no exclusions and no overrides', () => {
    const selection = StagedImport.initial()

    expect(selection.excludedResources.size).toBe(0)
    expect(selection.resourceOverrides.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.isResourceIncluded
// ---------------------------------------------------------------------------

describe('StagedImport.isResourceIncluded', () => {
  it('should return true for a key not in excludedResources', () => {
    const selection = StagedImport.initial()

    expect(StagedImport.isResourceIncluded(selection, 'a')).toBe(true)
    expect(StagedImport.isResourceIncluded(selection, 'anything')).toBe(true)
  })

  it('should return false for a key in excludedResources', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial(), 'a')

    expect(StagedImport.isResourceIncluded(selection, 'a')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// StagedImport.toggleResource
// ---------------------------------------------------------------------------

describe('StagedImport.toggleResource', () => {
  it('should exclude an included resource', () => {
    const selection = StagedImport.toggleResource(StagedImport.initial(), 'a')

    expect(selection.excludedResources.has('a')).toBe(true)
  })

  it('should re-include an excluded resource', () => {
    const once = StagedImport.toggleResource(StagedImport.initial(), 'a')
    const twice = StagedImport.toggleResource(once, 'a')

    expect(twice.excludedResources.has('a')).toBe(false)
  })

  it('should not disturb other keys when toggling one', () => {
    const s1 = StagedImport.toggleResource(StagedImport.initial(), 'a')
    const s2 = StagedImport.toggleResource(s1, 'b')

    expect(s2.excludedResources.has('a')).toBe(true)
    expect(s2.excludedResources.has('b')).toBe(true)
  })

  it('should preserve resourceOverrides across toggles', () => {
    const edited = StagedImport.edit(StagedImport.initial(), 'a', resource('edited-alpha'))
    const toggled = StagedImport.toggleResource(edited, 'b')

    expect(toggled.resourceOverrides.get('a')).toEqual(resource('edited-alpha'))
  })

  it('should be self-inverse for any key (property)', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const initial = StagedImport.initial()
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
    const selection = StagedImport.setResourcesIncluded(StagedImport.initial(), ['a', 'b'], false)

    expect(StagedImport.isResourceIncluded(selection, 'a')).toBe(false)
    expect(StagedImport.isResourceIncluded(selection, 'b')).toBe(false)
    expect(StagedImport.isResourceIncluded(selection, 'c')).toBe(true)
  })

  it('should re-include every listed key when included is true', () => {
    const excluded = StagedImport.setResourcesIncluded(
      StagedImport.initial(),
      ['a', 'b', 'c'],
      false
    )
    const reincluded = StagedImport.setResourcesIncluded(excluded, ['a', 'b'], true)

    expect(StagedImport.isResourceIncluded(reincluded, 'a')).toBe(true)
    expect(StagedImport.isResourceIncluded(reincluded, 'b')).toBe(true)
    expect(StagedImport.isResourceIncluded(reincluded, 'c')).toBe(false)
  })

  it('should leave keys outside the batch untouched', () => {
    const start = StagedImport.toggleResource(StagedImport.initial(), 'c')
    const next = StagedImport.setResourcesIncluded(start, ['a'], false)

    expect(StagedImport.isResourceIncluded(next, 'c')).toBe(false)
  })

  it('should preserve resourceOverrides across the batch change', () => {
    const edited = StagedImport.edit(StagedImport.initial(), 'a', resource('edited-alpha'))
    const next = StagedImport.setResourcesIncluded(edited, ['a', 'b'], false)

    expect(next.resourceOverrides.get('a')).toEqual(resource('edited-alpha'))
  })

  it('property: excluding then re-including the same keys restores inclusion', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (keys) => {
        const excluded = StagedImport.setResourcesIncluded(StagedImport.initial(), keys, false)
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

  it('should preserve excludedResources across edits', () => {
    const toggled = StagedImport.toggleResource(StagedImport.initial(), 'b')
    const edited = StagedImport.edit(toggled, 'a', resource('edited'))

    expect(edited.excludedResources.has('b')).toBe(true)
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
