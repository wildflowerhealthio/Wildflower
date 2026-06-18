import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { isSourceActive, isTypeActive, readsFor, RECORD_SOURCES } from './convergence.ts'
import type { AppId, ResourceType } from './convergence.ts'

const APP_IDS: readonly AppId[] = ['refill', 'insights', 'schedule']
const RESOURCE_TYPES: readonly ResourceType[] = [
  'prescriptions',
  'labresults',
  'labreq',
  'appointments',
]

describe('readsFor', () => {
  it('should return the resource types each app is granted to read', () => {
    // Arrange / Act / Assert
    expect(readsFor('refill')).toEqual(['prescriptions'])
    expect(readsFor('insights')).toEqual(['prescriptions', 'labresults'])
    expect(readsFor('schedule')).toEqual(['labreq', 'appointments'])
  })
})

describe('isTypeActive', () => {
  it('should activate exactly the chips the selected app reads', () => {
    // Arrange — "Health insights" reads prescriptions + lab results only.
    // Act / Assert
    expect(isTypeActive('insights', 'prescriptions')).toBe(true)
    expect(isTypeActive('insights', 'labresults')).toBe(true)
    expect(isTypeActive('insights', 'labreq')).toBe(false)
    expect(isTypeActive('insights', 'appointments')).toBe(false)
  })

  it('should mark at least one resource type active for every app', () => {
    fc.assert(
      fc.property(fc.constantFrom(...APP_IDS), (app) => {
        // Act / Assert — no app grants an empty read-set.
        expect(RESOURCE_TYPES.some((type) => isTypeActive(app, type))).toBe(true)
      })
    )
  })

  it('should only ever activate types some source actually provides (no dead reads)', () => {
    // Arrange — the set of types present anywhere in the record. Computed
    // straight from the source data, independently of the read-set logic.
    const providedTypes = new Set<ResourceType>(RECORD_SOURCES.flatMap((source) => source.chips))

    fc.assert(
      fc.property(fc.constantFrom(...APP_IDS), (app) => {
        // Act / Assert — every readable type lights a real chip, so a
        // selection always has a visible effect.
        for (const type of RESOURCE_TYPES) {
          if (isTypeActive(app, type)) {
            expect(providedTypes.has(type)).toBe(true)
          }
        }
      })
    )
  })
})

describe('isSourceActive', () => {
  it('should light the two pharmacies and the lab for the default "insights" app', () => {
    expect(litSourceIds('insights')).toEqual(['rexall', 'shoppers', 'lifelabs'])
  })

  it('should light only the two pharmacies for "refill"', () => {
    expect(litSourceIds('refill')).toEqual(['rexall', 'shoppers'])
  })

  it('should light the clinic and the lab for "schedule"', () => {
    expect(litSourceIds('schedule')).toEqual(['okafor', 'lifelabs'])
  })

  it('should keep at least one source lit whichever app is selected', () => {
    fc.assert(
      fc.property(fc.constantFrom(...APP_IDS), (app) => {
        // Act / Assert — the record never goes completely dark.
        expect(RECORD_SOURCES.some((source) => isSourceActive(app, source))).toBe(true)
      })
    )
  })
})

// Helpers

/** Ids of the sources that stay lit for the given app, in record order. */
function litSourceIds(app: AppId): string[] {
  return RECORD_SOURCES.filter((source) => isSourceActive(app, source)).map((source) => source.id)
}
