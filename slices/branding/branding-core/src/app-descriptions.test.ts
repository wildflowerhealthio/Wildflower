import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  APP_DESCRIPTIONS,
  APP_SECTION_IDS,
  smartAppLaunchPages,
  type AppSectionId,
} from './app-descriptions.ts'
import { MARKETING_ANCHORS } from './nav.ts'
import { APP_SLUGS, SITE_ORIGIN, sectionUrl, siteRootFor } from './site.ts'

/**
 * Every described app: the homepage's SMART apps, and the launcher and
 * Wildflower Authorization, which have a landing page but no homepage row.
 */
const DESCRIBED_APP_IDS: readonly AppSectionId[] = [...APP_SECTION_IDS, 'launcher', 'authorization']

const appSectionIdArb = fc.constantFrom<AppSectionId>(...DESCRIBED_APP_IDS)

describe('APP_SECTION_IDS', () => {
  it('should list every described app but the launcher and authorization exactly once, and nothing else', () => {
    expect(DESCRIBED_APP_IDS.toSorted()).toStrictEqual(Object.keys(APP_DESCRIPTIONS).toSorted())
  })

  it('should only describe sections that exist in the deploy contract', () => {
    for (const id of DESCRIBED_APP_IDS) {
      expect(Object.keys(APP_SLUGS)).toContain(id)
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
  it('should list the five first-party SMART apps, at their own origins on the published site', () => {
    // Act
    const launchPages = smartAppLaunchPages(`${SITE_ORIGIN}/`)

    // Assert
    expect(launchPages).toStrictEqual([
      { app: 'medications', launchPageUrl: 'https://medications.wildflowerhealth.io/' },
      { app: 'importer', launchPageUrl: 'https://importer.wildflowerhealth.io/' },
      { app: 'plots', launchPageUrl: 'https://plots.wildflowerhealth.io/' },
      { app: 'syntheticData', launchPageUrl: 'https://synthetic-data.wildflowerhealth.io/' },
      { app: 'strength', launchPageUrl: 'https://strength.wildflowerhealth.io/' },
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

  it('should leave out the launcher, Wildflower Authorization and FHIR Sync for Pebble, which no URL launches', () => {
    const listedApps = smartAppLaunchPages(`${SITE_ORIGIN}/`).map(({ app }) => app)
    expect(listedApps).not.toContain('launcher')
    expect(listedApps).not.toContain('authorization')
    expect(listedApps).not.toContain('fhirSyncPebble')
  })

  it("should resolve every launch page to the app's own origin from the published launcher", () => {
    fc.assert(
      fc.property(
        fc.constantFrom('https://launcher.wildflowerhealth.io/', 'http://localhost:5173/'),
        (launcherBaseUrl) => {
          // Arrange
          const siteRoot = siteRootFor('launcher', launcherBaseUrl)

          // Act
          const launchPages = smartAppLaunchPages(siteRoot)

          // Assert
          for (const { app, launchPageUrl } of launchPages) {
            expect(launchPageUrl).toBe(sectionUrl(app))
          }
        }
      ),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it("should resolve every launch page to the preview's build from a PR preview's launcher", () => {
    // Arrange
    const previewRoot = 'https://wildflowerhealthio.github.io/staging/pr-7/'
    const siteRoot = siteRootFor('launcher', `${previewRoot}launcher/`)

    // Act
    const launchPages = smartAppLaunchPages(siteRoot)

    // Assert
    for (const { app, launchPageUrl } of launchPages) {
      expect(launchPageUrl).toBe(`${previewRoot}${APP_SLUGS[app]}/`)
    }
  })
})
