import { describe, expect, test } from 'vite-plus/test'

import { userCodeOf, withoutUserCode } from './user-code-query.ts'

describe('userCodeOf', () => {
  test('reads the user code the query names, percent-decoded', () => {
    expect(userCodeOf('?user_code=WDJB-MJHT')).toBe('WDJB-MJHT')
    expect(userCodeOf('?theme=dark&user_code=a%26b+c')).toBe('a&b c')
  })

  test('is empty when the query names no code', () => {
    expect(userCodeOf('')).toBe('')
    expect(userCodeOf('?theme=dark')).toBe('')
  })
})

describe('withoutUserCode', () => {
  test('drops the user code and keeps the rest of the address', () => {
    expect(withoutUserCode('https://ruth.relay.example/oauth/device?user_code=WDJB-MJHT')).toBe(
      'https://ruth.relay.example/oauth/device'
    )
    expect(
      withoutUserCode('https://ruth.relay.example/oauth/device?theme=dark&user_code=WDJB-MJHT#top')
    ).toBe('https://ruth.relay.example/oauth/device?theme=dark#top')
  })
})
