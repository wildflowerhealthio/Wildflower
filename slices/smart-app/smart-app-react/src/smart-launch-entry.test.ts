import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { launchErrorFrom, type SmartLaunchConfig } from 'fhir-r4-react/smart'
import type * as Smart from 'fhir-r4-react/smart'
import { authorizeFromLaunchPage, runSmartLaunchEntry } from './smart-launch-entry.ts'

// Stub the one call that leaves the page: fhirclient's authorize redirect.
const { authorizeSmartLaunchMock } = vi.hoisted(() => ({
  authorizeSmartLaunchMock: vi.fn<(config: SmartLaunchConfig) => Promise<void>>(),
}))
vi.mock('fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof Smart>()),
  authorizeSmartLaunch: authorizeSmartLaunchMock,
}))

const LAUNCH = {
  clientId: 'importer-app',
  scope: 'launch openid fhirUser system/DocumentReference.cruds',
}

const LAUNCH_PAGE =
  'https://wildflowerhealth.io/importer-app/launch.html?iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz'

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
      redirectUri: 'https://wildflowerhealth.io/importer-app/',
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
    expect(`${target.origin}${target.pathname}`).toBe('https://wildflowerhealth.io/importer-app/')
    const reported = launchErrorFrom(target.search)
    expect(reported?.message).toContain('Failed to fetch')
    expect(reported).toHaveProperty('iss', 'https://ehr.example/fhir')
  })
})

describe('runSmartLaunchEntry', () => {
  beforeEach(() => {
    stubMatchMedia()
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('should show the loading line under the brand bar while the authorize is in flight', async () => {
    // Arrange — discovery never settles, as while the redirect is pending
    authorizeSmartLaunchMock.mockReturnValue(new Promise<never>(() => undefined))

    // Act
    void runSmartLaunchEntry({ launch: LAUNCH, loadingMessage: 'Launching Importer…' })

    // Assert
    expect(await screen.findByText('Launching Importer…')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Wildflower, home' })).toBeDefined()
    expect(authorizeSmartLaunchMock).toHaveBeenCalledWith({
      ...LAUNCH,
      redirectUri: new URL('.', window.location.href).href,
    })
  })
})

// Helpers

/**
 * jsdom ships no `matchMedia`, which the entry's OS colour-scheme listener
 * calls. Stubbed as "light, never changes".
 */
function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }))
}
