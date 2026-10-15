import { describe, expect, test } from 'vite-plus/test'

import { userCodeOf } from './user-code-query.ts'

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
