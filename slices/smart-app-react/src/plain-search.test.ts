import { describe, expect, it } from 'vite-plus/test'

import { parsePlainSearch, stringifyPlainSearch } from './plain-search.ts'

describe('parsePlainSearch', () => {
  it.each([
    { case: 'a numeric id', search: '?patient=123', patient: '123' },
    { case: 'a decimal-looking id', search: '?patient=1.50', patient: '1.50' },
    { case: 'an exponent-looking id', search: '?patient=1e5', patient: '1e5' },
    { case: 'every patient', search: '?patient=*', patient: '*' },
  ])('should read $case as the address bar holds it', ({ search, patient }) => {
    expect(parsePlainSearch(search)).toStrictEqual({ patient })
  })

  it('should read an empty query as no keys', () => {
    expect(parsePlainSearch('')).toStrictEqual({})
  })
})

describe('stringifyPlainSearch', () => {
  it('should write a numeric-looking id unquoted', () => {
    expect(stringifyPlainSearch({ patient: '1.50' })).toBe('?patient=1.50')
  })

  it('should leave out unset keys, and write nothing for none', () => {
    expect(stringifyPlainSearch({ patient: undefined })).toBe('')
  })

  it('should round-trip what it reads', () => {
    const search = '?patient=1e5&tab=x'
    expect(stringifyPlainSearch(parsePlainSearch(search))).toBe(search)
  })
})
