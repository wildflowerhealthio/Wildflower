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

/**
 * Decodes a catalog with excess keys refused, so a misspelt optional field
 * (`helpURL`, a `preassignedCredentials.redirectURIs`) fails instead of being
 * dropped.
 */
const decodeStrictly = Schema.decodeUnknownSync(AppCatalog.Catalog, {
  onExcessProperty: 'error',
})

const decodeCatalog = (): AppCatalog.Catalog => decodeStrictly(catalogJson)

/** The catalog's smart-apps, which carry a `launchUrl`. */
const smartAppsOf = (catalog: AppCatalog.Catalog): readonly AppCatalog.SmartApp[] =>
  catalog.filter((entry): entry is AppCatalog.SmartApp => entry.type === 'smart-app')

/** The smart-app launched from `launchUrl`. */
const smartAppAt = (
  catalog: AppCatalog.Catalog,
  launchUrl: string
): AppCatalog.SmartApp | undefined =>
  smartAppsOf(catalog).find((entry) => entry.launchUrl === launchUrl)

/** The publisher of every app this repository builds. */
const wildflowerPublisherOf = (catalog: AppCatalog.Catalog): AppCatalog.Publisher | undefined =>
  smartAppAt(catalog, sectionUrl('medications'))?.publisher

describe('public/apps.json', () => {
  it('should decode as a Catalog', () => {
    expect(decodeCatalog).not.toThrow()
  })

  it('should refuse a misspelt key in an entry, its publisher or its preassignedCredentials', () => {
    const [entry, ...rest] = catalogJson
    if (entry === undefined) throw new Error('apps.json lists no app')
    for (const [key, misspelt] of [
      ['helpURL', { ...entry, helpURL: 'https://example.com/help' }],
      ['URL', { ...entry, publisher: { ...entry.publisher, URL: 'https://example.com/' } }],
      [
        'redirectURIs',
        { ...entry, preassignedCredentials: { ...entry.preassignedCredentials, redirectURIs: [] } },
      ],
    ] as const) {
      expect(() => decodeStrictly([misspelt, ...rest])).toThrow(
        new RegExp(`\\["${key}"\\][\\s│└─]*is unexpected`)
      )
    }
  })

  it.each(APP_SECTION_IDS)(
    'should list %s at its root as a Wildflower app with its menu name, description and policies',
    (app) => {
      const catalog = decodeCatalog()
      const entry = smartAppAt(catalog, sectionUrl(app))
      expect(entry).toMatchObject({
        name: navLabelOf(app),
        type: 'smart-app',
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
    const launchUrls = smartAppsOf(decodeCatalog()).map(({ launchUrl }) => launchUrl)
    for (const { launchPageUrl } of SMART_APP_LAUNCH_PAGES) {
      expect(launchUrls).toContain(launchPageUrl)
    }
  })

  it('should list only smart-apps, every one enrolling and described in Canadian English', () => {
    const catalog = decodeCatalog()
    expect(smartAppsOf(catalog)).toEqual(catalog)
    for (const entry of catalog) {
      expect(entry).toMatchObject({ isEnrolling: true, contentLanguage: 'en-CA' })
      expect(entry.languagesSupported).toBeUndefined()
      expect(entry.intents).toBeUndefined()
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
