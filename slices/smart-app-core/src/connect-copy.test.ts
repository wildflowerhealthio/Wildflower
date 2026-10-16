import { describe, expect, it } from 'vite-plus/test'

import { RELAY_NAME_DESCRIPTION } from './connect-copy.ts'
import { RELAY_DOMAIN } from './server-presets.ts'

describe('RELAY_NAME_DESCRIPTION', () => {
  it('names the relay domain the relay name sits under', () => {
    expect(RELAY_NAME_DESCRIPTION).toContain(`https://[Name]${RELAY_DOMAIN}`)
  })
})
