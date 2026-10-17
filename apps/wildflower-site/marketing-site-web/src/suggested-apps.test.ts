import { APP_DESCRIPTIONS, SMART_APP_LAUNCH_PAGES } from '@wildflowerhealthio/branding-core'
import { SuggestedApps } from '@wildflowerhealthio/suggested-apps-core-js'
import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import suggestedAppsJson from '../public/suggested_apps.json' with { type: 'json' }

const decodeSuggestedApps = (): SuggestedApps.SuggestedApps =>
  Schema.decodeUnknownSync(SuggestedApps.SuggestedApps)(suggestedAppsJson)

describe('public/suggested_apps.json', () => {
  it('should decode as SuggestedApps', () => {
    expect(decodeSuggestedApps).not.toThrow()
  })

  it.each(SMART_APP_LAUNCH_PAGES)(
    'should list $app as a first-party app with its launch page, name and tagline',
    ({ app, launchPageUrl }) => {
      const suggestedApp = decodeSuggestedApps().apps.find(
        ({ launchUrl }) => launchUrl === launchPageUrl
      )
      expect(suggestedApp).toMatchObject({
        publisher: { kind: 'first-party' },
        name: APP_DESCRIPTIONS[app].name,
        description: APP_DESCRIPTIONS[app].tagline,
      })
    }
  )
})
