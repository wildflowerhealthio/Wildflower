import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { Option } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import {
  appRootRedirect,
  clearReturnRoute,
  readReturnRoute,
  RETURN_ROUTE_STORAGE_KEY,
  saveReturnRoute,
} from './return-route.ts'

/** The page's origin, which jsdom serves the tests from. */
const ORIGIN = window.location.origin

/** An EHR launch's parameters, as a launch URL carries them. */
const LAUNCH = 'iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz'

/** What the store holds after `saveReturnRoute` on `href`, served from `servedDirectory`. */
const savedFor = (href: string, servedDirectory?: string): string | null => {
  saveReturnRoute(window.sessionStorage, href, servedDirectory)
  return window.sessionStorage.getItem(RETURN_ROUTE_STORAGE_KEY)
}

afterEach(() => {
  window.sessionStorage.clear()
})

describe('saveReturnRoute', () => {
  it('should save a deep route as a router path, with its own query and fragment, less the launch', () => {
    expect(savedFor(`${ORIGIN}/pr-7/calendar?patient=123&${LAUNCH}#today`, '/pr-7/')).toBe(
      '/calendar?patient=123#today'
    )
  })

  it('should save a route under the page’s own directory without a served directory', () => {
    expect(savedFor(`${ORIGIN}/anonymize?source=pharmacy&${LAUNCH}`)).toBe(
      '/anonymize?source=pharmacy'
    )
  })

  it.each([
    { case: 'a launch', search: `?${LAUNCH}` },
    { case: 'a standalone launch’s lone iss', search: '?iss=https%3A%2F%2Fehr.example%2Ffhir' },
    { case: 'a query of its own', search: `?${LAUNCH}&patient=123` },
  ])('should save nothing for the app root carrying $case', ({ search }) => {
    expect(savedFor(`${ORIGIN}/pr-7/${search}`, '/pr-7/')).toBeNull()
  })

  it('should clear what an earlier launch saved when this one is at the app root', () => {
    // Arrange
    window.sessionStorage.setItem(RETURN_ROUTE_STORAGE_KEY, '/calendar')

    // Act / Assert
    expect(savedFor(`${ORIGIN}/?${LAUNCH}`)).toBeNull()
  })
})

describe('readReturnRoute', () => {
  it('should read the saved route and leave it saved', () => {
    // Arrange
    const route = '/patients/1.50/plan?x=1#top'
    window.sessionStorage.setItem(RETURN_ROUTE_STORAGE_KEY, route)

    // Act / Assert — read twice, the same both times
    expect(readReturnRoute(window.sessionStorage)).toEqual(Option.some(route))
    expect(readReturnRoute(window.sessionStorage)).toEqual(Option.some(route))
  })

  it('should read nothing when nothing was saved, or once it is cleared', () => {
    expect(readReturnRoute(window.sessionStorage)).toEqual(Option.none())
    window.sessionStorage.setItem(RETURN_ROUTE_STORAGE_KEY, '/calendar')

    clearReturnRoute(window.sessionStorage)

    expect(readReturnRoute(window.sessionStorage)).toEqual(Option.none())
  })

  it.each([
    { case: 'a protocol-relative URL', saved: '//evil.example/calendar' },
    { case: 'a backslashed protocol-relative URL', saved: '/\\evil.example/calendar' },
    { case: 'a full URL', saved: 'https://evil.example/calendar' },
    { case: 'the app root, which would redirect to itself', saved: '/?patient=123' },
  ])('should ignore $case', ({ saved }) => {
    window.sessionStorage.setItem(RETURN_ROUTE_STORAGE_KEY, saved)

    expect(readReturnRoute(window.sessionStorage)).toEqual(Option.none())
  })
})

/**
 * A router under `basepath` whose `/` throws `appRootRedirect(startRoute)`,
 * loaded at that app root, as a callback leaves the page; returns the history
 * it ran over.
 */
const loadAppRoot = async (
  basepath: string,
  startRoute: string
): Promise<ReturnType<typeof createMemoryHistory>> => {
  const rootRoute = createRootRoute()
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      beforeLoad: () => {
        throw appRootRedirect(startRoute)
      },
    }),
    createRoute({ getParentRoute: () => rootRoute, path: '/patients' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/patients/$patientId' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/patients/$patientId/plan' }),
  ])
  const history = createMemoryHistory({ initialEntries: [basepath] })
  await createRouter({ routeTree, history, basepath }).load()
  return history
}

describe('appRootRedirect', () => {
  it.each([
    { basepath: '/', expected: '/patients/p1' },
    { basepath: '/pr-7/', expected: '/pr-7/patients/p1' },
  ])(
    'should replace the app root under $basepath with the start route when none is saved',
    async ({ basepath, expected }) => {
      const history = await loadAppRoot(basepath, '/patients/p1')

      expect(history.location.href).toBe(expected)
      expect(history.length).toBe(1)
    }
  )

  it.each([
    { basepath: '/', expected: '/patients/p2/plan?x=1#top' },
    { basepath: '/pr-7/', expected: '/pr-7/patients/p2/plan?x=1#top' },
  ])(
    'should replace the app root under $basepath with the saved route over the start route',
    async ({ basepath, expected }) => {
      // Arrange
      saveReturnRoute(
        window.sessionStorage,
        `${ORIGIN}${basepath}patients/p2/plan?x=1&${LAUNCH}#top`,
        basepath
      )

      // Act
      const history = await loadAppRoot(basepath, '/patients')

      // Assert
      expect(history.location.href).toBe(expected)
      expect(history.length).toBe(1)
    }
  )
})
