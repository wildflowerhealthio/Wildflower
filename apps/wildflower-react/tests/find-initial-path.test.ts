import { NavigationBridge } from 'contracts-core'
import { Schema } from 'effect'
import { afterEach, describe, expect, type Mock, test, vi } from 'vite-plus/test'
import { findInitialPath } from '../src/bridges/find-initial-path.ts'

const encodeNav = (path: string): string =>
  Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
    _tag: 'HostRequestedWebNavigation',
    path,
  })

const stubWarn = (): Mock<typeof console.warn> =>
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

describe('findInitialPath', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("returns '/' for an empty array", () => {
    const warn = stubWarn()
    expect(findInitialPath([])).toBe('/')
    expect(warn).not.toHaveBeenCalled()
  })

  test("returns '/' when no entry decodes as HostRequestedWebNavigation", () => {
    const warn = stubWarn()
    const otherTag = JSON.stringify({ _tag: 'SomeOtherTag', payload: 'whatever' })
    expect(findInitialPath([otherTag])).toBe('/')
    expect(warn).not.toHaveBeenCalled()
  })

  test('returns the path of the first matching entry, ignoring later ones', () => {
    stubWarn()
    const messages = [encodeNav('/first'), encodeNav('/second'), encodeNav('/third')]
    expect(findInitialPath(messages)).toBe('/first')
  })

  test('skips earlier non-matching tags and returns the first matching entry', () => {
    stubWarn()
    const messages = [
      JSON.stringify({ _tag: 'AuthTokenIssued', token: 'abc' }),
      encodeNav('/target'),
    ]
    expect(findInitialPath(messages)).toBe('/target')
  })

  test('warns and continues on malformed JSON, then returns the next valid entry', () => {
    const warn = stubWarn()
    const messages = ['not-json-at-all{', encodeNav('/after-malformed')]
    expect(findInitialPath(messages)).toBe('/after-malformed')
    expect(warn).toHaveBeenCalled()
  })

  test("warns and returns '/' when the only entry is malformed JSON", () => {
    const warn = stubWarn()
    expect(findInitialPath(['not-json-at-all{'])).toBe('/')
    expect(warn).toHaveBeenCalled()
  })
})
