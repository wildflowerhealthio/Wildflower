import { fc, it as fcIt } from '@fast-check/jest'
import { FALLBACK_TAB_KEY, TABS, tabForPath } from './tab-mapping.ts'

const NON_FALLBACK_TABS = TABS.filter((t) => t.key !== FALLBACK_TAB_KEY)

describe('tabForPath', () => {
  describe('exact-path match', () => {
    it.each(TABS)('returns $key when input equals $path', (tab) => {
      expect(tabForPath(tab.path)).toBe(tab.key)
    })
  })

  describe('descendant match', () => {
    // A pathname is a descendant when it sits under `tab.path/`. The
    // suffix arbitrary excludes path-segment-terminating characters so
    // we don't accidentally generate `/apps` from `/app + s` (which
    // would prove the negative case instead).
    fcIt.prop({
      tab: fc.constantFrom(...TABS),
      suffix: fc.stringMatching(/^[a-zA-Z0-9_\-./]+$/),
    })('returns the tab when the input lives under `tab.path/<suffix>`', ({ tab, suffix }) => {
      const input = `${tab.path}/${suffix}`
      expect(tabForPath(input)).toBe(tab.key)
    })
  })

  describe('non-descendant prefix sibling', () => {
    // `/appsxyz` shares `/apps` as a *string* prefix but is NOT a
    // descendant. The implementation distinguishes by requiring a
    // trailing `/`. The fallback tab is excluded because for it
    // "not this tab" and "is the fallback" collapse to the same
    // value, which would let every iteration trivially pass.
    fcIt.prop({
      tab: fc.constantFrom(...NON_FALLBACK_TABS),
      sibling: fc.stringMatching(/^[a-zA-Z0-9]+$/),
    })('does not match a path that shares the prefix but no trailing slash', ({ tab, sibling }) => {
      const input = `${tab.path}${sibling}`
      expect(tabForPath(input)).not.toBe(tab.key)
    })
  })

  describe('fallback', () => {
    it('returns FALLBACK_TAB_KEY for the empty string', () => {
      expect(tabForPath('')).toBe(FALLBACK_TAB_KEY)
    })

    it('returns FALLBACK_TAB_KEY for the SPA root `/`', () => {
      expect(tabForPath('/')).toBe(FALLBACK_TAB_KEY)
    })

    fcIt.prop({
      pathname: fc
        .stringMatching(/^\/[a-zA-Z0-9_\-./]*$/)
        .filter((s) => !TABS.some((t) => s === t.path || s.startsWith(`${t.path}/`))),
    })('returns FALLBACK_TAB_KEY for any pathname not under a tab root', ({ pathname }) => {
      expect(tabForPath(pathname)).toBe(FALLBACK_TAB_KEY)
    })
  })
})
