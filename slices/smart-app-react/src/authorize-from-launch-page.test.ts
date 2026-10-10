import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { launchErrorFrom, type SmartLaunchConfig } from 'fhir-r4-react/smart'
import type * as Smart from 'fhir-r4-react/smart'
import { authorizeFromLaunchPage } from './authorize-from-launch-page.ts'

// Stub the one call that leaves the page: fhirclient's authorize redirect.
const { authorizeSmartLaunchMock } = vi.hoisted(() => ({
  authorizeSmartLaunchMock: vi.fn<(config: SmartLaunchConfig) => Promise<void>>(),
}))
vi.mock('fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof Smart>()),
  authorizeSmartLaunch: authorizeSmartLaunchMock,
}))

const LAUNCH = {
  clientId: '165cd26573e5ac72378e6ad2d2198330',
  scope: 'launch openid fhirUser system/DocumentReference.cruds',
}

const LAUNCH_PAGE =
  'https://wildflowerhealth.io/importer/?iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz'

beforeEach(() => {
  authorizeSmartLaunchMock.mockReset()
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
      redirectUri: 'https://wildflowerhealth.io/importer/',
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
    expect(`${target.origin}${target.pathname}`).toBe('https://wildflowerhealth.io/importer/')
    const reported = launchErrorFrom(target.search)
    expect(reported?.message).toContain('Failed to fetch')
    expect(reported).toHaveProperty('iss', 'https://ehr.example/fhir')
  })
})
