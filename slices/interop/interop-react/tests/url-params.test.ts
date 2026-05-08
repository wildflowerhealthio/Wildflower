import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import { consumeUrlParam, readSurface, readUrlParam } from '../src/url-params.ts'

// JSDOM rejects cross-origin `history.replaceState` calls, so the test
// only varies the path + query relative to whatever origin JSDOM chose
// for `window.location` (typically `http://localhost:3000/`).
const setSearch = (search: string): void => {
  window.history.replaceState(null, '', `/${search}`)
}

const resetSearch = (): void => {
  window.history.replaceState(null, '', '/')
}

describe('readUrlParam', () => {
  beforeEach(() => {
    resetSearch()
  })
  afterEach(() => {
    resetSearch()
  })

  test('returns the parameter value when present', () => {
    setSearch('?token=abc')
    expect(readUrlParam('token')).toBe('abc')
  })

  test('returns null when the parameter is absent', () => {
    expect(readUrlParam('token')).toBeNull()
  })

  test('does not strip the parameter from the address bar', () => {
    setSearch('?token=abc')
    readUrlParam('token')
    expect(window.location.search).toBe('?token=abc')
  })
})

describe('consumeUrlParam', () => {
  beforeEach(() => {
    resetSearch()
  })
  afterEach(() => {
    resetSearch()
  })

  test('returns the parameter value and strips it from the URL', () => {
    setSearch('?token=abc&keep=1')
    expect(consumeUrlParam('token')).toBe('abc')
    expect(window.location.search).toBe('?keep=1')
  })

  test('returns null and leaves the URL untouched when the parameter is absent', () => {
    setSearch('?keep=1')
    expect(consumeUrlParam('token')).toBeNull()
    expect(window.location.search).toBe('?keep=1')
  })
})

describe('readSurface', () => {
  beforeEach(() => {
    resetSearch()
  })
  afterEach(() => {
    resetSearch()
  })

  test('returns "expo" when ?surface=expo is present', () => {
    setSearch('?surface=expo')
    expect(readSurface()).toBe('expo')
  })

  test('returns null for any other value', () => {
    setSearch('?surface=other')
    expect(readSurface()).toBeNull()
  })

  test('returns null when the parameter is absent', () => {
    expect(readSurface()).toBeNull()
  })
})
