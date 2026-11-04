import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  DiscoveryFailed,
  type SignInError,
} from '@wildflowerhealthio/authorization-core/smart-client'
import {
  decodeLaunchError,
  LAUNCH_ERROR_PARAM,
  launchError,
  rootArrivalFrom,
  type RootArrival,
  type SmartLaunchConfig,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import type * as Smart from '@wildflowerhealthio/fhir-r4-react/smart'
import { type Data, Effect, Option } from 'effect'
import { redirectForLaunchRequest } from './redirect-for-launch-request.ts'
import { RETURN_ROUTE_STORAGE_KEY } from './return-route.ts'

// Stub the one call that leaves the page: the sign-in's authorize redirect.
const { redirectToSignInMock } = vi.hoisted(() => ({
  redirectToSignInMock:
    vi.fn<
      (config: SmartLaunchConfig, launch: string | undefined) => Effect.Effect<void, SignInError>
    >(),
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
  redirectToSignInMock.mockReturnValue(Effect.void)
  window.sessionStorage.clear()
})

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

  it('should send a failed sign-in back to the app root, naming the reason and the iss', async () => {
    // Arrange — an unreachable or CORS-blocked `iss`
    redirectToSignInMock.mockReturnValue(
      Effect.fail(new DiscoveryFailed({ reason: 'Could not reach the server.' }))
    )

    // Act
    const failure = await redirectForLaunchRequest(LAUNCH, launchOf(LAUNCH_PAGE), LAUNCH_PAGE)

    // Assert — the target is the app root, and the root's banner can decode it
    const target = new URL(Option.getOrThrow(failure))
    expect(`${target.origin}${target.pathname}`).toBe('https://importer.wildflowerhealth.io/')
    const reported = launchError(
      decodeLaunchError(target.searchParams.get(LAUNCH_ERROR_PARAM) ?? '')
    )
    expect(reported.message).toContain('Could not reach the server.')
    expect(reported).toHaveProperty('iss', 'https://ehr.example/fhir')
  })

  it('should save the route the launch started on before the page leaves', async () => {
    // Arrange — the route is saved by the time the authorize starts
    let savedAtAuthorize: string | null = null
    redirectToSignInMock.mockImplementation(() => {
      savedAtAuthorize = window.sessionStorage.getItem(RETURN_ROUTE_STORAGE_KEY)
      return Effect.void
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
