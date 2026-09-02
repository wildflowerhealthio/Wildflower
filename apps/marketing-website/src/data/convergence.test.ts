import { sectionRootPath } from 'branding-core'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  CONNECT_APPS,
  isSourceActive,
  isTypeActive,
  readsFor,
  RECORD_SOURCES,
} from './convergence.ts'
import type { AppId, ResourceType } from './convergence.ts'

const APP_IDS: readonly AppId[] = CONNECT_APPS.map((app) => app.id)
const RESOURCE_TYPES: readonly ResourceType[] = [
  'prescriptions',
  'labresults',
  'labreq',
  'appointments',
  'documents',
]

describe('CONNECT_APPS', () => {
  it('should only give an href to an app published on this domain', () => {
    // Arrange / Act / Assert — a link is a promise the app is reachable, so
    // only the "published" ones may carry one.
    for (const app of CONNECT_APPS) {
      expect(app.href === undefined).toBe(app.availability !== 'published')
    }
  })

  it('should publish the Medications app at its assembled GitHub Pages path', () => {
    // Arrange / Act / Assert — `apps/github-pages` stages medications-app at
    // `/medications-app`, so that is the link the site has to emit.
    const medications = CONNECT_APPS.find((app) => app.id === 'medications')
    expect(medications?.href).toBe('/medications-app')
    expect(medications?.href).toBe(sectionRootPath('medications'))
  })

  it('should publish the Importer at its assembled GitHub Pages path', () => {
    // Arrange / Act / Assert — `apps/github-pages` stages the importer app's
    // build (`wildflower-importer`, from `apps/importer-web`) at
    // `/importer-app`, so that is the link the site has to emit.
    const importer = CONNECT_APPS.find((app) => app.id === 'importer')
    expect(importer?.href).toBe('/importer-app')
    expect(importer?.href).toBe(sectionRootPath('importer'))
  })

  it('should publish Web Trace at its assembled GitHub Pages path', () => {
    // Arrange / Act / Assert — `apps/github-pages` stages the Web Trace app's
    // build (`wildflower-web-trace`) at `/web-trace-app`, so that is the link
    // the site has to emit.
    const webTrace = CONNECT_APPS.find((app) => app.id === 'webtrace')
    expect(webTrace?.availability).toBe('published')
    expect(webTrace?.href).toBe('/web-trace-app')
    expect(webTrace?.href).toBe(sectionRootPath('webTrace'))
  })
})

describe('readsFor', () => {
  it('should return the resource types each app is granted to read', () => {
    // Arrange / Act / Assert
    expect(readsFor('medications')).toEqual(['prescriptions'])
    expect(readsFor('importer')).toEqual(['documents'])
    expect(readsFor('webtrace')).toEqual(['documents'])
    expect(readsFor('visits')).toEqual(['labreq', 'appointments', 'labresults'])
  })
})

describe('isTypeActive', () => {
  it('should activate exactly the chips the selected app reads', () => {
    // Arrange — Medications reads prescriptions only.
    // Act / Assert
    expect(isTypeActive('medications', 'prescriptions')).toBe(true)
    expect(isTypeActive('medications', 'documents')).toBe(false)
    expect(isTypeActive('medications', 'labresults')).toBe(false)
    expect(isTypeActive('medications', 'appointments')).toBe(false)
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
  it('should light both pharmacies for the default "medications" app', () => {
    expect(litSourceIds('medications')).toEqual(['rexall', 'shoppers'])
  })

  it('should light both pharmacies for "webtrace", whose imports produced the documents', () => {
    expect(litSourceIds('webtrace')).toEqual(['rexall', 'shoppers'])
  })

  it('should light both pharmacies for "importer", which reads those same archives', () => {
    expect(litSourceIds('importer')).toEqual(['rexall', 'shoppers'])
  })

  it('should light the clinic and the lab for "visits"', () => {
    expect(litSourceIds('visits')).toEqual(['okafor', 'lifelabs'])
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
