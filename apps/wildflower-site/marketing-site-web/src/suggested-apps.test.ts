import {
  APP_DESCRIPTIONS,
  HEADER_NAV_GROUPS,
  SMART_APP_LAUNCH_PAGES,
} from '@wildflowerhealthio/branding-core'
import { SuggestedApps } from '@wildflowerhealthio/suggested-apps-core-js'
import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import suggestedAppsJson from '../public/suggested_apps.json' with { type: 'json' }

/**
 * The name the site's header menu gives a section, the marketing site's name
 * for the app (`Wildflower Medications`, not its landing page's `Medication Viewer`).
 */
const navLabelOf = (section: string): string | undefined =>
  HEADER_NAV_GROUPS.flatMap(({ links }) => links).find(
    (link) => link.kind === 'section' && link.section === section
  )?.label

const decodeSuggestedApps = (): SuggestedApps.SuggestedApps =>
  Schema.decodeUnknownSync(SuggestedApps.SuggestedApps)(suggestedAppsJson)

describe('public/suggested_apps.json', () => {
  it('should decode as SuggestedApps', () => {
    expect(decodeSuggestedApps).not.toThrow()
  })

  it.each(SMART_APP_LAUNCH_PAGES)(
    'should list $app as a first-party app with its launch page, menu name and tagline',
    ({ app, launchPageUrl }) => {
      const suggestedApp = decodeSuggestedApps().apps.find(
        ({ launchUrl }) => launchUrl === launchPageUrl
      )
      expect(suggestedApp).toMatchObject({
        publisher: { kind: 'first-party' },
        name: navLabelOf(app),
        description: APP_DESCRIPTIONS[app].tagline,
      })
    }
  )
})
