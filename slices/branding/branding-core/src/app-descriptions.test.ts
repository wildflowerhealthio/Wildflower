import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  APP_DESCRIPTIONS,
  APP_SECTION_IDS,
  smartAppLaunchPages,
  type AppSectionId,
} from './app-descriptions.ts'
import { MARKETING_ANCHORS } from './nav.ts'
import { SECTION_PATHS, SITE_ORIGIN, siteRootFor } from './site.ts'

/**
 * Every described app: the homepage's SMART apps, and the Synthetic Data Loader
 * and the owner UI, which have a landing page but no homepage row.
 */
const DESCRIBED_APP_IDS: readonly AppSectionId[] = [...APP_SECTION_IDS, 'syntheticData', 'app']

const appSectionIdArb = fc.constantFrom<AppSectionId>(...DESCRIBED_APP_IDS)

describe('APP_SECTION_IDS', () => {
  it('should list every described app but the data loader and the owner UI exactly once, and nothing else', () => {
    expect(DESCRIBED_APP_IDS.toSorted()).toStrictEqual(Object.keys(APP_DESCRIPTIONS).toSorted())
  })

  it('should only describe sections that exist in the deploy contract', () => {
    for (const id of DESCRIBED_APP_IDS) {
      expect(Object.keys(SECTION_PATHS)).toContain(id)
    }
  })
})

describe('APP_DESCRIPTIONS', () => {
  it('should give every app a name, a tagline, and at least one non-blank paragraph', () => {
    fc.assert(
      fc.property(appSectionIdArb, (id) => {
        const description = APP_DESCRIPTIONS[id]
        expect(description.name.trim()).not.toBe('')
        expect(description.tagline.trim()).not.toBe('')
        expect(description.paragraphs.length).toBeGreaterThan(0)
        for (const paragraph of description.paragraphs) {
          expect(paragraph.trim()).not.toBe('')
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should point every app at an anchor the homepage renders', () => {
    fc.assert(
      fc.property(appSectionIdArb, (id) => {
        expect(MARKETING_ANCHORS).toContain(APP_DESCRIPTIONS[id].anchor)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('should name the app in its launch label, so the homepage link reads as a link into it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DESCRIBED_APP_IDS), (id) => {
        const { name, launch } = APP_DESCRIPTIONS[id]
        if (launch === undefined) return
        expect(launch.label).toContain(name)
        expect(launch.label.endsWith('→')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

describe('smartAppLaunchPages', () => {
  it('should list the six first-party SMART apps, at their roots on the canonical site', () => {
    // Act
    const launchPages = smartAppLaunchPages(`${SITE_ORIGIN}/`)

    // Assert
    expect(launchPages).toStrictEqual([
      {
        app: 'medications',
        launchPageUrl: 'https://wildflowerhealth.io/medications-app/',
      },
      { app: 'importer', launchPageUrl: 'https://wildflowerhealth.io/importer-app/' },
      { app: 'webTrace', launchPageUrl: 'https://wildflowerhealth.io/web-trace-app/' },
      {
        app: 'healthViewer',
        launchPageUrl: 'https://wildflowerhealth.io/health-viewer-app/',
      },
      {
        app: 'syntheticData',
        launchPageUrl: 'https://wildflowerhealth.io/synthetic-data-app/',
      },
      { app: 'lifting', launchPageUrl: 'https://wildflowerhealth.io/lifting/' },
    ])
  })

  it('should list exactly the described apps a URL launches, in description order', () => {
    // Arrange
    const launchedApps = DESCRIBED_APP_IDS.filter(
      (id) => APP_DESCRIPTIONS[id].launchesFromUrl === true
    )

    // Act
    const listedApps = smartAppLaunchPages(`${SITE_ORIGIN}/`).map(({ app }) => app)

    // Assert
    expect(listedApps.toSorted()).toStrictEqual(launchedApps.toSorted())
    expect(listedApps).toStrictEqual(
      Object.keys(APP_DESCRIPTIONS).filter((id) => listedApps.some((app) => app === id))
    )
  })

  it('should leave out the owner UI and FHIR Sync for Pebble, which no URL launches', () => {
    const listedApps = smartAppLaunchPages(`${SITE_ORIGIN}/`).map(({ app }) => app)
    expect(listedApps).not.toContain('app')
    expect(listedApps).not.toContain('fhirSyncPebble')
  })

  it("should resolve every launch page under the site root it is given, in the app's own section", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'https://wildflowerhealth.io/app/',
          'https://wildflowerhealthio.github.io/staging/pr-7/app/',
          'http://localhost:5173/'
        ),
        (ownerUiBaseUrl) => {
          // Arrange
          const siteRoot = siteRootFor('app', ownerUiBaseUrl)

          // Act
          const launchPages = smartAppLaunchPages(siteRoot)

          // Assert
          for (const { app, launchPageUrl } of launchPages) {
            expect(launchPageUrl).toBe(`${siteRoot}${SECTION_PATHS[app]}/`)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })
})
