import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  REDIRECT_PARAM,
  basenameOf,
  restoreRedirectedUrl,
  restoredUrl,
  type RestorableLocation,
} from './spa-redirect.ts'

/** URL path segments: no separators, no dots (so no traversal), not empty. */
const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/)

/** An app basename, always slash-suffixed: `/`, `/medications-app/`, … */
const basenameArb = fc
  .array(segment, { maxLength: 3 })
  .map((segments) => (segments.length === 0 ? '/' : `/${segments.join('/')}/`))

/** A route below the app root, site-relative: `/trace`, `/a/b`, … */
const routeArb = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => `/${s.join('/')}`)

/** Query parameters that ride along with the redirect, never named `redirect`. */
const otherParametersArb = fc
  .array(fc.tuple(segment, segment), { maxLength: 3 })
  .map((pairs) => pairs.filter(([name]) => name !== REDIRECT_PARAM))
  .map((pairs) => new URLSearchParams(pairs))

/** The search string a 404 redirect produces: `redirect` plus the passengers. */
const searchFor = (route: string, others: URLSearchParams): string => {
  const parameters = new URLSearchParams(others)
  parameters.set(REDIRECT_PARAM, route)
  return `?${parameters.toString()}`
}

/** Parse a root-relative URL the way a browser would, for structural asserts. */
const parse = (url: string): URL => new URL(url, 'https://wildflowerhealth.io')

describe('basenameOf', () => {
  it('should return the directory of the landing path', () => {
    expect(basenameOf('/medications-app/')).toBe('/medications-app/')
    expect(basenameOf('/medications-app/index.html')).toBe('/medications-app/')
    expect(basenameOf('/')).toBe('/')
  })

  it('should always end with a slash', () => {
    fc.assert(
      fc.property(fc.webPath(), (pathname) => {
        expect(basenameOf(pathname).endsWith('/')).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('restoredUrl', () => {
  it('should restore the route the 404 page carried, under the app basename', () => {
    expect(
      restoredUrl({
        pathname: '/web-trace-app/',
        search: '?redirect=/trace&iss=https%3A%2F%2Fexample.com',
        hash: '#t',
      })
    ).toBe('/web-trace-app/trace?iss=https%3A%2F%2Fexample.com#t')
  })

  it('should strip a leading copy of the basename from the redirect path', () => {
    expect(
      restoredUrl({
        pathname: '/medications-app/',
        search: '?redirect=/medications-app/x',
        hash: '',
      })
    ).toBe('/medications-app/x')
  })

  it('should land on the app root when the redirect path is the basename itself', () => {
    expect(
      restoredUrl({ pathname: '/medications-app/', search: '?redirect=/medications-app', hash: '' })
    ).toBe('/medications-app/')
  })

  it('should keep a route named like the app directory when the path is site-absolute', () => {
    // What 404.html sends for `/medications-app/medications-app`; app-relative
    // (`?redirect=/medications-app`) it would read as the app root.
    expect(
      restoredUrl({
        pathname: '/medications-app/',
        search: '?redirect=/medications-app/medications-app',
        hash: '',
      })
    ).toBe('/medications-app/medications-app')
  })

  it('should return undefined when the load carries no redirect', () => {
    expect(
      restoredUrl({ pathname: '/medications-app/', search: '?iss=https%3A%2F%2Fx', hash: '' })
    ).toBeUndefined()
    expect(restoredUrl({ pathname: '/medications-app/', search: '', hash: '' })).toBeUndefined()
  })

  it('should return undefined for an empty redirect rather than rewriting to the root', () => {
    expect(
      restoredUrl({ pathname: '/medications-app/', search: '?redirect=', hash: '' })
    ).toBeUndefined()
  })

  it('should always produce a URL inside the app basename', () => {
    fc.assert(
      fc.property(basenameArb, routeArb, otherParametersArb, (basename, route, others) => {
        const url = restoredUrl({ pathname: basename, search: searchFor(route, others), hash: '' })
        expect(url).toBeDefined()
        expect(parse(url ?? '').pathname.startsWith(basename)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never leave the redirect parameter in the restored URL', () => {
    fc.assert(
      fc.property(basenameArb, routeArb, otherParametersArb, (basename, route, others) => {
        const url = restoredUrl({ pathname: basename, search: searchFor(route, others), hash: '' })
        expect(parse(url ?? '').searchParams.has(REDIRECT_PARAM)).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should preserve every other query parameter and the fragment', () => {
    fc.assert(
      fc.property(
        basenameArb,
        routeArb,
        otherParametersArb,
        fc.option(segment, { nil: undefined }),
        (basename, route, others, fragment) => {
          const hash = fragment === undefined ? '' : `#${fragment}`
          const url = restoredUrl({ pathname: basename, search: searchFor(route, others), hash })
          const restored = parse(url ?? '')
          expect([...restored.searchParams]).toStrictEqual([...others])
          expect(restored.hash).toBe(hash)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always restore the deep link the 404 page was reached by', () => {
    fc.assert(
      fc.property(basenameArb, routeArb, otherParametersArb, (basename, route, others) => {
        // What the reader typed, before GitHub Pages fell through to 404.html —
        // which passes that path on as is, site-absolute.
        const deepLink = `${basename}${route.replace(/^\/+/, '')}`
        const url = restoredUrl({
          pathname: basename,
          search: searchFor(deepLink, others),
          hash: '',
        })
        expect(parse(url ?? '').pathname).toBe(deepLink)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should be idempotent: a restored URL is not itself a redirect to complete', () => {
    fc.assert(
      fc.property(basenameArb, routeArb, otherParametersArb, (basename, route, others) => {
        const url = restoredUrl({ pathname: basename, search: searchFor(route, others), hash: '' })
        const restored = parse(url ?? '')
        expect(
          restoredUrl({
            pathname: restored.pathname,
            search: restored.search,
            hash: restored.hash,
          })
        ).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

/** The `window` stand-in below: the two fields the restoration touches. */
interface Target {
  readonly location: RestorableLocation
  readonly history: { readonly replaceState: ReplaceState }
  /** The same spy as `history.replaceState`, for assertions. */
  readonly replaceState: ReturnType<typeof vi.fn<ReplaceState>>
}

/** The `history.replaceState` signature the restoration calls through. */
type ReplaceState = (data: unknown, unused: string, url: string) => void

describe('restoreRedirectedUrl', () => {
  const targetAt = (location: RestorableLocation): Target => {
    const replaceState = vi.fn<ReplaceState>()
    return { location, history: { replaceState }, replaceState }
  }

  it('should replace the current history entry with the restored URL', () => {
    const target = targetAt({
      pathname: '/importer-app/',
      search: '?redirect=/files&code=abc',
      hash: '',
    })
    expect(restoreRedirectedUrl(target)).toBe('/importer-app/files?code=abc')
    expect(target.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      '',
      '/importer-app/files?code=abc'
    )
  })

  it('should leave the URL alone when there is no redirect to complete', () => {
    fc.assert(
      fc.property(basenameArb, otherParametersArb, (basename, others) => {
        const search = others.toString() === '' ? '' : `?${others.toString()}`
        const target = targetAt({ pathname: basename, search, hash: '' })
        expect(restoreRedirectedUrl(target)).toBeUndefined()
        expect(target.replaceState).not.toHaveBeenCalled()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should write exactly the URL it returns', () => {
    fc.assert(
      fc.property(basenameArb, routeArb, otherParametersArb, (basename, route, others) => {
        const target = targetAt({
          pathname: basename,
          search: searchFor(route, others),
          hash: '',
        })
        const returned = restoreRedirectedUrl(target)
        expect(target.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', returned)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
