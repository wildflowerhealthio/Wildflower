import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { stripTrailingSlash } from './index.ts'

describe('stripTrailingSlash', () => {
  it('removes a single trailing slash', () => {
    expect(stripTrailingSlash('https://example.com/')).toBe('https://example.com')
  })

  it('passes through strings without a trailing slash unchanged', () => {
    expect(stripTrailingSlash('https://example.com')).toBe('https://example.com')
  })

  it('only removes the last slash (not all trailing slashes)', () => {
    expect(stripTrailingSlash('foo//')).toBe('foo/')
  })

  it('passes through the empty string', () => {
    expect(stripTrailingSlash('')).toBe('')
  })

  it('passes through a single slash to the empty string', () => {
    expect(stripTrailingSlash('/')).toBe('')
  })

  it('property: result never ends in a single slash unless the input ended in two or more', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const stripped = stripTrailingSlash(s)
        if (s.endsWith('//')) {
          // Only one slash removed; the second-to-last may still trail.
          expect(stripped).toBe(s.slice(0, -1))
        } else if (s.endsWith('/')) {
          expect(stripped.endsWith('/')).toBe(false)
        } else {
          expect(stripped).toBe(s)
        }
      })
    )
  })
})
