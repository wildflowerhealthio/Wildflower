import { sectionUrl } from '@wildflowerhealthio/branding-core'
import { describe, expect, it } from 'vite-plus/test'
import { authorization_app_base_url as authorizationAppBaseUrl } from '../../../host/host-app/tauri-shared-config.json'
import { REGISTERED_REDIRECT_URI } from './config.ts'

// The Tauri host gives every server it runs the address in
// `tauri-shared-config.json`, which the server advertises as its SMART
// `management_endpoint`. Rust can't read branding-core, so the JSON repeats the
// published address; this pins the copy, and the app's own redirect, to it.
describe('published Wildflower Authorization address', () => {
  it("should be the app's own origin in tauri-shared-config.json", () => {
    expect(authorizationAppBaseUrl).toBe(sectionUrl('authorization'))
  })

  it('should be the redirect URI a sign-in from the published app returns to', () => {
    expect(REGISTERED_REDIRECT_URI).toBe(sectionUrl('authorization'))
  })
})
