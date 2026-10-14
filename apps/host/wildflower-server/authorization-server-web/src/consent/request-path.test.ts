import { describe, expect, test } from 'vite-plus/test'

import { requestIdOf } from './request-path.ts'

describe('requestIdOf', () => {
  test('reads the request id the consent card path names, percent-decoded', () => {
    expect(requestIdOf('/oauth/authorize/req-1/consent')).toBe('req-1')
    expect(requestIdOf('/oauth/authorize/a%2Fb%20c%3F/consent')).toBe('a/b c?')
  })
})
