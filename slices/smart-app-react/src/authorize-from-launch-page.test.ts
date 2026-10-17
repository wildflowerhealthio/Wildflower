import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { launchErrorFrom, type SmartLaunchConfig } from '@wildflowerhealthio/fhir-r4-react/smart'
import type * as Smart from '@wildflowerhealthio/fhir-r4-react/smart'
import { authorizeFromLaunchPage } from './authorize-from-launch-page.ts'
import { RETURN_ROUTE_STORAGE_KEY } from './return-route.ts'

// Stub the one call that leaves the page: fhirclient's authorize redirect.
const { authorizeSmartLaunchMock } = vi.hoisted(() => ({
  authorizeSmartLaunchMock: vi.fn<(config: SmartLaunchConfig) => Promise<void>>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof Smart>()),
  authorizeSmartLaunch: authorizeSmartLaunchMock,
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

beforeEach(() => {
  authorizeSmartLaunchMock.mockReset()
  window.sessionStorage.clear()
})

describe('authorizeFromLaunchPage', () => {
  it('should authorize with the app root as the redirect target', async () => {
    // Arrange
    authorizeSmartLaunchMock.mockResolvedValue(undefined)

    // Act
    const failure = await authorizeFromLaunchPage(LAUNCH, LAUNCH_PAGE)

    // Assert — the registration, plus the root the launch page sits in
    expect(authorizeSmartLaunchMock).toHaveBeenCalledWith({
      ...LAUNCH,
      redirectUri: 'https://importer.wildflowerhealth.io/',
    })
    expect(failure).toBeNull()
  })

  it('should send a rejected authorize back to the app root, naming the reason and the iss', async () => {
    // Arrange — an unreachable or CORS-blocked `iss`
    authorizeSmartLaunchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    // Act
    const failure = await authorizeFromLaunchPage(LAUNCH, LAUNCH_PAGE)

    // Assert — the target is the app root, and the root's banner can decode it
    expect(failure).not.toBeNull()
    const target = new URL(failure ?? '')
    expect(`${target.origin}${target.pathname}`).toBe('https://importer.wildflowerhealth.io/')
    const reported = launchErrorFrom(target.search)
    expect(reported?.message).toContain('Failed to fetch')
    expect(reported).toHaveProperty('iss', 'https://ehr.example/fhir')
  })

  it('should save the route the launch started on before the page leaves', async () => {
    // Arrange — the route is saved by the time the authorize starts
    let savedAtAuthorize: string | null = null
    authorizeSmartLaunchMock.mockImplementation(() => {
      savedAtAuthorize = window.sessionStorage.getItem(RETURN_ROUTE_STORAGE_KEY)
      return Promise.resolve()
    })

    // Act
    await authorizeFromLaunchPage(LAUNCH, DEEP_LAUNCH_PAGE)

    // Assert — still the app root as the redirect target
    expect(savedAtAuthorize).toBe('/anonymize?source=pharmacy')
    expect(authorizeSmartLaunchMock).toHaveBeenCalledWith({
      ...LAUNCH,
      redirectUri: 'https://importer.wildflowerhealth.io/',
    })
  })

  it('should return a launch at a nested route to the app’s served root', async () => {
    // Arrange
    authorizeSmartLaunchMock.mockResolvedValue(undefined)

    // Act — a route two directories deep, which is no registered redirect URI
    await authorizeFromLaunchPage(
      LAUNCH,
      'https://strength.wildflowerhealth.io/pr-7/patients/123/today?iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz',
      '/pr-7/'
    )

    // Assert
    expect(authorizeSmartLaunchMock).toHaveBeenCalledWith({
      ...LAUNCH,
      redirectUri: 'https://strength.wildflowerhealth.io/pr-7/',
    })
    expect(window.sessionStorage.getItem(RETURN_ROUTE_STORAGE_KEY)).toBe('/patients/123/today')
  })
})
