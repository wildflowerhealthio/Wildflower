import { fc, it as fcIt } from '@fast-check/jest'
import { TABS, tabForPath } from './tab-mapping.ts'

describe('tabForPath', () => {
  describe('exact-path match', () => {
    fcIt.prop({ tab: fc.constantFrom(...TABS) })(
      'returns the tab whose path equals the input verbatim',
      ({ tab }) => {
        expect(tabForPath(tab.path)).toBe(tab.key)
      }
    )
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
    // trailing `/`.
    fcIt.prop({
      tab: fc.constantFrom(...TABS),
      sibling: fc.stringMatching(/^[a-zA-Z0-9]+$/),
    })('does not match a path that shares the prefix but no trailing slash', ({ tab, sibling }) => {
      const input = `${tab.path}${sibling}`
      // Either the input maps to a *different* tab (none of which
      // can match in this construction) or falls back to TABS[0].
      // When `tab` IS the fallback tab, "not this tab" and "is the
      // fallback" collapse to the same value — assert against the
      // fallback directly so the case still exercises a property.
      if (tab.key === TABS[0].key) {
        expect(tabForPath(input)).toBe(TABS[0].key)
        return
      }
      expect(tabForPath(input)).not.toBe(tab.key)
    })
  })

  describe('fallback', () => {
    it('returns TABS[0].key for the empty string', () => {
      expect(tabForPath('')).toBe(TABS[0].key)
    })

    it('returns TABS[0].key for the SPA root `/`', () => {
      expect(tabForPath('/')).toBe(TABS[0].key)
    })

    fcIt.prop({
      pathname: fc
        .stringMatching(/^\/[a-zA-Z0-9_\-./]*$/)
        .filter((s) => !TABS.some((t) => s === t.path || s.startsWith(`${t.path}/`))),
    })('returns TABS[0].key for any pathname not under a tab root', ({ pathname }) => {
      expect(tabForPath(pathname)).toBe(TABS[0].key)
    })
  })
})
