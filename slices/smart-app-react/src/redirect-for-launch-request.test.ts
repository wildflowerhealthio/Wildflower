import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { PendingRequestUnusable } from '@wildflowerhealthio/authorization-core/smart-client'
import {
  decodeLaunchError,
  LAUNCH_ERROR_PARAM,
  launchError,
  RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
  rootArrivalFrom,
  SmartSupport,
  type RootArrival,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import type * as Smart from '@wildflowerhealthio/fhir-r4-react/smart'
import { type Data, Effect, Option } from 'effect'
import { redirectForLaunchRequest } from './redirect-for-launch-request.ts'
import { RETURN_ROUTE_STORAGE_KEY } from './return-route.ts'

// Stub the one call that leaves the page: the sign-in's redirect.
const { redirectToSignInMock } = vi.hoisted(() => ({
  redirectToSignInMock: vi.fn<typeof Smart.redirectToSignIn>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof Smart>()),
  redirectToSignIn: redirectToSignInMock,
}))

const LAUNCH = {
  clientId: '165cd26573e5ac72378e6ad2d2198330',
  scope: 'launch openid fhirUser system/DocumentReference.cruds',
}

const LAUNCH_PAGE =
  'https://importer.wildflowerhealth.io/?iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz'

/** A launch at one of the importer's routes, with a query of the route's own. */
const DEEP_LAUNCH_PAGE =
  'https://importer.wildflowerhealth.io/anonymize?source=pharmacy&iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz'

/** The launch request the page at `launchPageHref` is, as the app root reads it on arrival. */
const launchOf = (launchPageHref: string): Data.TaggedEnum.Value<RootArrival, 'LaunchRequest'> => {
  const arrival = rootArrivalFrom(new URL(launchPageHref).search)
  if (arrival._tag !== 'LaunchRequest') throw new Error(`${launchPageHref} is no launch request`)
  return arrival
}

beforeEach(() => {
  redirectToSignInMock.mockReset()
  redirectToSignInMock.mockReturnValue(Effect.succeed(SmartSupport.Open()))
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The app-root banner's reading of the `?launchError` the failed launch was sent to. */
const reportedLaunchError = (failure: Option.Option<string>): ReturnType<typeof launchError> => {
  const target = new URL(Option.getOrThrow(failure))
  expect(`${target.origin}${target.pathname}`).toBe('https://importer.wildflowerhealth.io/')
  return launchError(decodeLaunchError(target.searchParams.get(LAUNCH_ERROR_PARAM) ?? ''))
}

describe('redirectForLaunchRequest', () => {
  it('should authorize with the app root as the redirect target', async () => {
    // Act
    const failure = await redirectForLaunchRequest(LAUNCH, launchOf(LAUNCH_PAGE), LAUNCH_PAGE)

    // Assert — the registration, the root the launch page sits in, and the launch
    expect(redirectToSignInMock).toHaveBeenCalledWith(
      {
        ...LAUNCH,
        redirectUri: 'https://importer.wildflowerhealth.io/',
        fhirBaseUrl: 'https://ehr.example/fhir',
      },
      'xyz'
    )
    expect(failure).toEqual(Option.none())
  })

  it('should authorize a lone iss as a standalone launch against it', async () => {
    // Act
    const lonePage = 'https://importer.wildflowerhealth.io/?iss=https%3A%2F%2Fehr.example%2Ffhir'
    await redirectForLaunchRequest(LAUNCH, launchOf(lonePage), lonePage)

    // Assert
    expect(redirectToSignInMock).toHaveBeenCalledWith(
      {
        ...LAUNCH,
        redirectUri: 'https://importer.wildflowerhealth.io/',
        fhirBaseUrl: 'https://ehr.example/fhir',
      },
      undefined
    )
  })

  it('should send an unreachable iss back to the app root, naming the reason and the iss', async () => {
    // Arrange — an unreachable or CORS-blocked `iss`
    redirectToSignInMock.mockReturnValue(
      Effect.succeed(SmartSupport.Unreachable({ reason: 'Failed to fetch' }))
    )

    // Act
    const failure = await redirectForLaunchRequest(LAUNCH, launchOf(LAUNCH_PAGE), LAUNCH_PAGE)

    // Assert — the root's banner reads it with the connect menu's wording
    const reported = reportedLaunchError(failure)
    expect(reported.message).toContain('Could not reach https://ehr.example/fhir.')
    expect(reported.message).toContain('Failed to fetch')
    expect(reported).toHaveProperty('iss', 'https://ehr.example/fhir')
  })

  it('should send a sign-in that could not retain its request back to the app root', async () => {
    // Arrange
    redirectToSignInMock.mockReturnValue(
      Effect.fail(new PendingRequestUnusable({ reason: 'session storage is blocked' }))
    )

    // Act
    const failure = await redirectForLaunchRequest(LAUNCH, launchOf(LAUNCH_PAGE), LAUNCH_PAGE)

    // Assert
    expect(reportedLaunchError(failure).message).toContain('session storage is blocked')
  })

  it('should sign in to an open iss by a self-addressed redirect to the app root', async () => {
    // Arrange — the real sign-in, against a server that serves no SMART configuration
    const { redirectToSignIn } = await vi.importActual<typeof Smart>(
      '@wildflowerhealthio/fhir-r4-react/smart'
    )
    redirectToSignInMock.mockImplementation(redirectToSignIn)
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 404 })))
    )
    const assign = vi.fn<(url: string) => void>()
    vi.stubGlobal('location', { protocol: 'https:', href: LAUNCH_PAGE, assign })
    const lonePage = 'https://importer.wildflowerhealth.io/?iss=https%3A%2F%2Fehr.example%2Ffhir'

    // Act
    const failure = await redirectForLaunchRequest(LAUNCH, launchOf(lonePage), lonePage)

    // Assert — back to the app root with the state it retained, for the open server
    expect(failure).toEqual(Option.none())
    const target = new URL(assign.mock.lastCall?.[0] ?? '')
    expect(`${target.origin}${target.pathname}`).toBe('https://importer.wildflowerhealth.io/')
    expect(
      JSON.parse(window.sessionStorage.getItem(RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY) ?? '')
    ).toEqual({
      expectedState: target.searchParams.get('state'),
      fhirBaseUrl: 'https://ehr.example/fhir',
    })
  })

  it('should save the route the launch started on before the page leaves', async () => {
    // Arrange — the route is saved by the time the authorize starts
    let savedAtAuthorize: string | null = null
    redirectToSignInMock.mockImplementation(() => {
      savedAtAuthorize = window.sessionStorage.getItem(RETURN_ROUTE_STORAGE_KEY)
      return Effect.succeed(SmartSupport.Open())
    })

    // Act
    await redirectForLaunchRequest(LAUNCH, launchOf(DEEP_LAUNCH_PAGE), DEEP_LAUNCH_PAGE)

    // Assert — still the app root as the redirect target
    expect(savedAtAuthorize).toBe('/anonymize?source=pharmacy')
    expect(redirectToSignInMock).toHaveBeenCalledWith(
      {
        ...LAUNCH,
        redirectUri: 'https://importer.wildflowerhealth.io/',
        fhirBaseUrl: 'https://ehr.example/fhir',
      },
      'xyz'
    )
  })

  it('should return a launch at a nested route to the app’s basepath', async () => {
    // Act — a route two directories deep, which is no registered redirect URI
    const nestedPage =
      'https://strength.wildflowerhealth.io/pr-7/patients/123/today?iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz'
    await redirectForLaunchRequest(LAUNCH, launchOf(nestedPage), nestedPage, '/pr-7/')

    // Assert
    expect(redirectToSignInMock).toHaveBeenCalledWith(
      {
        ...LAUNCH,
        redirectUri: 'https://strength.wildflowerhealth.io/pr-7/',
        fhirBaseUrl: 'https://ehr.example/fhir',
      },
      'xyz'
    )
    expect(window.sessionStorage.getItem(RETURN_ROUTE_STORAGE_KEY)).toBe('/patients/123/today')
  })
})
