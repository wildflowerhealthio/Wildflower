import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as QueryParam from './query-param.ts'

// JSDOM rejects cross-origin `history.replaceState` calls, so the test
// only varies the path + query relative to whatever origin JSDOM chose
// for `window.location` (typically `http://localhost:3000/`).
const setSearch = (search: string): void => {
  window.history.replaceState(null, '', `/${search}`)
}

const resetSearch = (): void => {
  window.history.replaceState(null, '', '/')
}

beforeEach(() => {
  resetSearch()
})
afterEach(() => {
  resetSearch()
})

describe('readQueryParam', () => {
  test('returns the parameter value when present', () => {
    setSearch('?token=abc')
    expect(QueryParam.readFromWindowLocation('token')).toBe('abc')
  })

  test('does not strip the parameter from the address bar', () => {
    setSearch('?token=abc')
    QueryParam.readFromWindowLocation('token')
    expect(window.location.search).toBe('?token=abc')
  })

  test('returns the same value as URL.searchParams.get for any key', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
        fc.string(),
        (params, key) => {
          const url = new URL(window.location.href)
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
          window.history.replaceState(null, '', `${url.pathname}${url.search}`)
          expect(QueryParam.readFromWindowLocation(key)).toBe(url.searchParams.get(key))
          resetSearch()
        }
      )
    )
  })
})

describe('consumeQueryParam', () => {
  test('returns the parameter value and strips it from the URL', () => {
    setSearch('?token=abc&keep=1')
    expect(QueryParam.consumeFromWindowLocation('token')).toBe('abc')
    expect(window.location.search).toBe('?keep=1')
  })

  test('returns null and leaves the URL untouched when the parameter is absent', () => {
    setSearch('?keep=1')
    expect(QueryParam.consumeFromWindowLocation('token')).toBeNull()
    expect(window.location.search).toBe('?keep=1')
  })
})
