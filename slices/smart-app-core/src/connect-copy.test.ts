import { describe, expect, it } from 'vite-plus/test'

import { RELAY_NAME_DESCRIPTION } from './connect-copy.ts'

describe('RELAY_NAME_DESCRIPTION', () => {
  it('names the relay domain the relay name sits under', () => {
    expect(RELAY_NAME_DESCRIPTION).toBe(
      'This server is found at https://[Name].relay.wildflowerhealth.io'
    )
  })
})
