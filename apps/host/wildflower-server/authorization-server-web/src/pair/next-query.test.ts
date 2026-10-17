import { describe, expect, test } from 'vite-plus/test'

import { nextOf } from './next-query.ts'

describe('nextOf', () => {
  test('is the query’s next, decoded', () => {
    expect(nextOf('?next=%2Foauth%2Fauthorize%3Fclient_id%3Dapp%26state%3Ds')).toBe(
      '/oauth/authorize?client_id=app&state=s'
    )
  })

  test('is empty when the query names none', () => {
    expect(nextOf('')).toBe('')
    expect(nextOf('?then=back')).toBe('')
  })
})
