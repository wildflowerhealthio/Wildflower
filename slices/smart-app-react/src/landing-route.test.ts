import { createMemoryHistory } from '@tanstack/react-router'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import {
  forgetLandingRoute,
  LANDING_ROUTE_STORAGE_KEY,
  landOnRoute,
  restoreLandingRoute,
  saveLandingRoute,
} from './landing-route.ts'

/** The page's origin, which jsdom serves the tests from. */
const ORIGIN = window.location.origin

/** An EHR launch's parameters, as a launch URL carries them. */
const LAUNCH = 'iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz'

/** What the store holds after `saveLandingRoute` on `href`. */
const savedFor = (href: string): string | null => {
  saveLandingRoute(window.sessionStorage, href)
  return window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)
}

/** A page at the app root of `basepath`, as the callback leaves it. */
const pageAt = (
  basepath: string
): { history: ReturnType<typeof createMemoryHistory>; basepath: string } => ({
  history: createMemoryHistory({ initialEntries: [basepath] }),
  basepath,
})

afterEach(() => {
  window.sessionStorage.clear()
})

describe('saveLandingRoute', () => {
  it('should keep a deep route with its own query and fragment, less the launch', () => {
    expect(savedFor(`${ORIGIN}/pr-7/calendar?patient=123&${LAUNCH}#today`)).toBe(
      '/pr-7/calendar?patient=123#today'
    )
  })

  it('should keep the app root when it carries a query of its own', () => {
    expect(savedFor(`${ORIGIN}/?${LAUNCH}&patient=123`)).toBe('/?patient=123')
  })

  it.each([
    { case: 'a launch', search: `?${LAUNCH}` },
    { case: 'a standalone launch’s lone iss', search: '?iss=https%3A%2F%2Fehr.example%2Ffhir' },
    { case: 'a callback', search: '?code=abc&state=xyz' },
    { case: 'a failure', search: '?launchError=e30&error=access_denied&error_description=no' },
  ])('should keep nothing for the bare app root carrying only $case', ({ search }) => {
    expect(savedFor(`${ORIGIN}/pr-7/${search}`)).toBeNull()
  })

  it('should keep a nested route, and nothing for the root, of an app served from a directory', () => {
    // Act
    saveLandingRoute(window.sessionStorage, `${ORIGIN}/pr-7/patients/1.50/plan?${LAUNCH}`, '/pr-7/')

    // Assert
    expect(window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)).toBe(
      '/pr-7/patients/1.50/plan'
    )
    saveLandingRoute(window.sessionStorage, `${ORIGIN}/pr-7/?${LAUNCH}`, '/pr-7/')
    expect(window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)).toBeNull()
  })

  it('should clear what an earlier launch kept when this one is at the app root', () => {
    // Arrange
    window.sessionStorage.setItem(LANDING_ROUTE_STORAGE_KEY, '/calendar')

    // Act / Assert
    expect(savedFor(`${ORIGIN}/?${LAUNCH}`)).toBeNull()
  })
})

describe('restoreLandingRoute', () => {
  it('should replace the app root with the kept route, once', () => {
    // Arrange
    saveLandingRoute(window.sessionStorage, `${ORIGIN}/pr-7/calendar?patient=123&${LAUNCH}#today`)
    const page = pageAt('/pr-7/')

    // Act
    restoreLandingRoute(window.sessionStorage, page)

    // Assert — on the history, and the key is spent
    expect(page.history.location.href).toBe('/pr-7/calendar?patient=123#today')
    expect(page.history.length).toBe(1)
    expect(window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)).toBeNull()
  })

  it('should leave the page where it is when nothing was kept', () => {
    const page = pageAt('/')

    restoreLandingRoute(window.sessionStorage, page)

    expect(page.history.location.href).toBe('/')
  })

  it.each([
    { case: 'a protocol-relative URL', saved: '//evil.example/calendar' },
    { case: 'a full URL', saved: 'https://evil.example/pr-7/calendar' },
    { case: 'a relative path', saved: 'calendar' },
    { case: 'another directory', saved: '/pr-8/calendar' },
    { case: 'a path climbing out of the directory', saved: '/pr-7/../pr-8/calendar' },
  ])('should ignore, and drop, $case', ({ saved }) => {
    // Arrange
    window.sessionStorage.setItem(LANDING_ROUTE_STORAGE_KEY, saved)
    const page = pageAt('/pr-7/')

    // Act
    restoreLandingRoute(window.sessionStorage, page)

    // Assert
    expect(page.history.location.href).toBe('/pr-7/')
    expect(window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)).toBeNull()
  })
})

describe('landOnRoute', () => {
  it('should replace the bare app root with the route, under the basepath', () => {
    // Arrange
    const page = pageAt('/pr-7/')

    // Act
    landOnRoute(page, '/patients/1.50')

    // Assert
    expect(page.history.location.href).toBe('/pr-7/patients/1.50')
    expect(page.history.length).toBe(1)
  })

  it('should leave a page off the app root where it is', () => {
    // Arrange — a landing route already restored
    const page = {
      history: createMemoryHistory({ initialEntries: ['/pr-7/calendar'] }),
      basepath: '/pr-7/',
    }

    // Act
    landOnRoute(page, '/patients')

    // Assert
    expect(page.history.location.href).toBe('/pr-7/calendar')
  })
})

describe('forgetLandingRoute', () => {
  it('should drop a kept route', () => {
    window.sessionStorage.setItem(LANDING_ROUTE_STORAGE_KEY, '/calendar')

    forgetLandingRoute(window.sessionStorage)

    expect(window.sessionStorage.getItem(LANDING_ROUTE_STORAGE_KEY)).toBeNull()
  })
})
