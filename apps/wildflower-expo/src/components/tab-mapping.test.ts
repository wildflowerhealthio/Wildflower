import { fc, it as fcIt } from '@fast-check/jest'
import { TABS, tabForPath } from './tab-mapping.ts'

describe('tabForPath', () => {
  describe('exact-path match', () => {
    it.each(TABS)('returns $key when input equals $path', (tab) => {
      expect(tabForPath(tab.path)).toBe(tab.key)
    })
  })

  describe('descendant match', () => {
    // A pathname is a descendant when it sits under `tab.path/`. The
    // suffix arbitrary excludes path-segment-terminating characters so
    // we don't accidentally generate `/home` from `/hom + e` (which
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
    // `/homexyz` shares `/home` as a *string* prefix but is NOT a
    // descendant. The implementation distinguishes by requiring a
    // trailing `/`.
    fcIt.prop({
      tab: fc.constantFrom(...TABS),
      sibling: fc.stringMatching(/^[a-zA-Z0-9]+$/),
    })('does not match a path that shares the prefix but no trailing slash', ({ tab, sibling }) => {
      const input = `${tab.path}${sibling}`
      expect(tabForPath(input)).not.toBe(tab.key)
    })
  })

  describe('fallback', () => {
    it('returns null for the empty string', () => {
      expect(tabForPath('')).toBeNull()
    })

    it('returns null for the SPA root `/`', () => {
      expect(tabForPath('/')).toBeNull()
    })

    fcIt.prop({
      pathname: fc
        .stringMatching(/^\/[a-zA-Z0-9_\-./]*$/)
        .filter((s) => !TABS.some((t) => s === t.path || s.startsWith(`${t.path}/`))),
    })('returns null for any pathname not under a tab root', ({ pathname }) => {
      expect(tabForPath(pathname)).toBeNull()
    })
  })
})
