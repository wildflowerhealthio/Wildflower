import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type * as StandaloneLaunch from '../smart/standalone-launch.ts'
import { ConnectMenu } from './connect-menu.tsx'
import { DEFAULT_SERVER_PRESET_GROUPS, DEFAULT_SERVER_PRESETS } from './server-presets.ts'

// Stub only the launch seam; keep the real `normalizeServerUrl` so the
// validation path under test is the production one, not a mock.
const startStandaloneLaunchMock = vi.hoisted(() => vi.fn())

vi.mock('../smart/standalone-launch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof StandaloneLaunch>()
  return { ...actual, startStandaloneLaunch: startStandaloneLaunchMock }
})

const PROPS = {
  clientId: 'medications-app',
  scope: 'launch openid fhirUser',
  redirectUri: 'https://app.example/',
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: the SMART path, which in production redirects the page away.
  startStandaloneLaunchMock.mockResolvedValue({ kind: 'smart' })
})

afterEach(() => {
  cleanup()
})

describe('ConnectMenu', () => {
  it('renders one button per preset, under its server group, and launches against the picked preset URL', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    // Every default group is a labelled region carrying its description, and
    // holds a button per preset whose accessible name is just the label — the
    // description sits beside the button, not inside it. Assertions derive
    // from the presets themselves, so editing the list never silently
    // outdates this test.
    for (const group of DEFAULT_SERVER_PRESET_GROUPS) {
      const region = within(screen.getByRole('region', { name: group.name }))
      expect(region.getByText(group.description)).toBeDefined()
      expect(region.getByText(group.address)).toBeDefined()
      for (const preset of group.presets) {
        expect(region.getByRole('button', { name: preset.label })).toBeDefined()
        expect(region.getByText(preset.description)).toBeDefined()
      }
    }

    // Act — pick a non-Local preset and launch against exactly its URL.
    const picked = DEFAULT_SERVER_PRESETS.at(1)
    if (picked === undefined) throw new Error('expected a second default preset to click')
    await user.click(screen.getByRole('button', { name: picked.label }))

    // Assert — the picked preset's URL is the iss, with the app's client/scope.
    expect(startStandaloneLaunchMock).toHaveBeenCalledTimes(1)
    expect(startStandaloneLaunchMock).toHaveBeenCalledWith({
      iss: picked.url,
      clientId: 'medications-app',
      scope: 'launch openid fhirUser',
      redirectUri: 'https://app.example/',
    })
  })

  it('launches against the normalized form of a valid free-entry URL', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    // A trailing slash the normalizer strips — the launch must see the canonical form.
    await user.type(screen.getByLabelText('FHIR server URL'), 'https://example.org/fhir/')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(startStandaloneLaunchMock).toHaveBeenCalledTimes(1)
    expect(startStandaloneLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ iss: 'https://example.org/fhir' })
    )
  })

  it('shows a validation message and does not launch on an invalid free entry', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    // A value the text input accepts but `normalizeServerUrl` rejects (no scheme).
    await user.type(screen.getByLabelText('FHIR server URL'), 'not-a-real-url')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(screen.getByText(/valid http\(s\) FHIR server URL/i)).toBeDefined()
    expect(startStandaloneLaunchMock).not.toHaveBeenCalled()
  })

  it('surfaces an unreachable probe as an error banner, still allowing a retry', async () => {
    startStandaloneLaunchMock.mockResolvedValue({ kind: 'unreachable', message: 'Failed to fetch' })
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    await user.click(screen.getByRole('button', { name: 'Local' }))

    await waitFor(() => {
      expect(screen.getByText(/Could not reach http:\/\/127\.0\.0\.1:8080\/fhir-r4/i)).toBeDefined()
    })
    // The menu is still there — the launch was attempted, and a retry is possible.
    expect(startStandaloneLaunchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Local' })).toBeDefined()
  })
})
