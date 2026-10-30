import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  APP_SLUGS,
  POLICY_IDS,
  POLICY_LABELS,
  POLICY_PATHS,
  SITE_ORIGIN,
  policyUrl,
  sectionUrl,
  type HostedAppId,
} from './site.ts'

const hostedAppIdArb = fc.constantFrom<HostedAppId>(
  'medications',
  'importer',
  'serverDocs',
  'ohifViewer',
  'fhirSyncPebble',
  'plots',
  'syntheticData',
  'strength',
  'watchLifts',
  'launcher',
  'authorization',
  'appCatalog'
)

describe('APP_SLUGS', () => {
  it('should name each hosted app by the subdomain its own origin is', () => {
    expect(APP_SLUGS).toStrictEqual({
      medications: 'medications',
      importer: 'importer',
      serverDocs: 'server-docs',
      ohifViewer: 'ohif-viewer',
      fhirSyncPebble: 'fhir-sync-pebble',
      plots: 'plots',
      syntheticData: 'synthetic-data',
      strength: 'strength',
      watchLifts: 'watch-lifts',
      launcher: 'launcher',
      authorization: 'authorization',
      appCatalog: 'app-catalog',
    })
  })

  it('should give every app a distinct slug that is a single DNS label', () => {
    const slugs = Object.values(APP_SLUGS)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })
})

describe('sectionUrl', () => {
  it('should return the site origin with a trailing slash for marketing', () => {
    expect(sectionUrl('marketing')).toBe('https://wildflowerhealth.io/')
  })

  it("should return each hosted app's own origin", () => {
    expect(sectionUrl('medications')).toBe('https://medications.wildflowerhealth.io/')
    expect(sectionUrl('serverDocs')).toBe('https://server-docs.wildflowerhealth.io/')
    expect(sectionUrl('plots')).toBe('https://plots.wildflowerhealth.io/')
    expect(sectionUrl('launcher')).toBe('https://launcher.wildflowerhealth.io/')
  })

  it("should put every hosted app at the root of a subdomain of the site's", () => {
    fc.assert(
      fc.property(hostedAppIdArb, (id) => {
        const url = new URL(sectionUrl(id))
        expect(url.href).toBe(`https://${APP_SLUGS[id]}.wildflowerhealth.io/`)
        expect(url.origin).not.toBe(SITE_ORIGIN)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('policyUrl', () => {
  it('should resolve each policy page to a slash-terminated URL on the canonical site', () => {
    expect(policyUrl('privacyPolicy')).toBe('https://wildflowerhealth.io/privacy-policy/')
    expect(policyUrl('consumerHealthData')).toBe(
      'https://wildflowerhealth.io/consumer-health-data/'
    )
    expect(policyUrl('terms')).toBe('https://wildflowerhealth.io/terms/')
    expect(policyUrl('deletion')).toBe('https://wildflowerhealth.io/deletion/')
  })

  it('should label every policy page', () => {
    expect(POLICY_IDS.toSorted()).toStrictEqual(Object.keys(POLICY_PATHS).toSorted())
    for (const id of POLICY_IDS) {
      expect(POLICY_LABELS[id].length).toBeGreaterThan(0)
    }
  })
})
