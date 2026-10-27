import { AppCatalog } from '@wildflowerhealthio/app-catalog-core-js'
import {
  APP_DESCRIPTIONS,
  APP_SECTION_IDS,
  HEADER_NAV_GROUPS,
  SITE_ORIGIN,
  SMART_APP_LAUNCH_PAGES,
  policyUrl,
  sectionUrl,
} from '@wildflowerhealthio/branding-core'
import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import catalogJson from '../public/apps.json' with { type: 'json' }

/** The name the site's header menu gives a section, the app's name in the catalog. */
const navLabelOf = (section: string): string | undefined =>
  HEADER_NAV_GROUPS.flatMap(({ links }) => links).find(
    (link) => link.kind === 'section' && link.section === section
  )?.label

const decodeCatalog = (): AppCatalog.Catalog =>
  Schema.decodeUnknownSync(AppCatalog.Catalog)(catalogJson)

/** The publisher of every app this repository builds. */
const wildflowerPublisherOf = (catalog: AppCatalog.Catalog): AppCatalog.Publisher | undefined =>
  catalog.find(({ launchUrl }) => launchUrl === sectionUrl('medications'))?.publisher

describe('public/apps.json', () => {
  it('should decode as a Catalog', () => {
    expect(decodeCatalog).not.toThrow()
  })

  it.each(APP_SECTION_IDS)(
    'should list %s at its root as a Wildflower app with its menu name, description and policies',
    (app) => {
      const catalog = decodeCatalog()
      const entry = catalog.find(({ launchUrl }) => launchUrl === sectionUrl(app))
      expect(entry).toMatchObject({
        name: navLabelOf(app),
        descriptionShort: APP_DESCRIPTIONS[app].tagline,
        description: APP_DESCRIPTIONS[app].paragraphs.join(' '),
        helpUrl: sectionUrl(app),
        privacyPolicyUrl: policyUrl('privacyPolicy'),
        termsOfServiceUrl: policyUrl('terms'),
        publisher: { name: 'Wildflower Health', url: SITE_ORIGIN },
        registrationModes: ['preassigned'],
      })
      expect(entry?.publisher).toEqual(wildflowerPublisherOf(catalog))
      expect(entry?.preassignedCredentials?.redirectUris).toContain(sectionUrl(app))
    }
  )

  it('should list every app a URL launches at that URL', () => {
    const launchUrls = decodeCatalog().map(({ launchUrl }) => launchUrl)
    for (const { launchPageUrl } of SMART_APP_LAUNCH_PAGES) {
      expect(launchUrls).toContain(launchPageUrl)
    }
  })

  it('should mark every app enrolling and written in Canadian English', () => {
    for (const entry of decodeCatalog()) {
      expect(entry).toMatchObject({ isEnrolling: true, lang: 'en-CA' })
      expect(entry.langSupported).toBeUndefined()
    }
  })

  it("should serve every Wildflower app's icon from the site", () => {
    const catalog = decodeCatalog()
    const wildflowerApps = catalog.filter(
      ({ publisher }) => publisher.id === wildflowerPublisherOf(catalog)?.id
    )
    expect(wildflowerApps.length).toBeGreaterThanOrEqual(SMART_APP_LAUNCH_PAGES.length)
    for (const { iconUrl } of wildflowerApps) {
      expect(new URL(iconUrl).origin).toBe(SITE_ORIGIN)
    }
  })
})
