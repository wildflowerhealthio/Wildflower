import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import { consumeQueryParam, readHostType, readQueryParam } from '../src/query-param.ts'

// JSDOM rejects cross-origin `history.replaceState` calls, so the test
// only varies the path + query relative to whatever origin JSDOM chose
// for `window.location` (typically `http://localhost:3000/`).
const setSearch = (search: string): void => {
  window.history.replaceState(null, '', `/${search}`)
}

const resetSearch = (): void => {
  window.history.replaceState(null, '', '/')
}

describe('readHostType', () => {
  beforeEach(() => {
    resetSearch()
  })
  afterEach(() => {
    resetSearch()
  })

  test('returns "expo" when ?host=expo is present', () => {
    setSearch('?host=expo')
    expect(readHostType()).toBe('expo')
  })

  test('returns null for any other value', () => {
    setSearch('?host=other')
    expect(readHostType()).toBeNull()
  })

  test('returns null when the parameter is absent', () => {
    expect(readHostType()).toBeNull()
  })
})

describe('readQueryParam', () => {
  beforeEach(() => {
    resetSearch()
  })
  afterEach(() => {
    resetSearch()
  })

  test('returns the parameter value when present', () => {
    setSearch('?token=abc')
    expect(readQueryParam('token')).toBe('abc')
  })

  test('returns null when the parameter is absent', () => {
    expect(readQueryParam('token')).toBeNull()
  })

  test('does not strip the parameter from the address bar', () => {
    setSearch('?token=abc')
    readQueryParam('token')
    expect(window.location.search).toBe('?token=abc')
  })
})

describe('consumeQueryParam', () => {
  beforeEach(() => {
    resetSearch()
  })
  afterEach(() => {
    resetSearch()
  })

  test('returns the parameter value and strips it from the URL', () => {
    setSearch('?token=abc&keep=1')
    expect(consumeQueryParam('token')).toBe('abc')
    expect(window.location.search).toBe('?keep=1')
  })

  test('returns null and leaves the URL untouched when the parameter is absent', () => {
    setSearch('?keep=1')
    expect(consumeQueryParam('token')).toBeNull()
    expect(window.location.search).toBe('?keep=1')
  })
})
