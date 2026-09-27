import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type * as Smart from 'fhir-r4-react/smart'
import { ConnectMenu } from './connect-menu.tsx'
import {
  DEFAULT_SERVER_PRESET_GROUPS,
  DEFAULT_SERVER_PRESETS,
  serverPresetGroupsFor,
} from './server-presets.ts'

// Stub only the launch seam; keep the real `normalizeServerUrl` so the
// validation path under test is the production one, not a mock.
const startStandaloneLaunchMock = vi.hoisted(() => vi.fn())

vi.mock('fhir-r4-react/smart', async (importOriginal) => {
  const actual = await importOriginal<typeof Smart>()
  return { ...actual, startStandaloneLaunch: startStandaloneLaunchMock }
})

const PROPS = {
  target: 'fhir-r4',
  clientId: 'medications-app',
  scope: 'launch openid fhirUser',
  redirectUri: 'https://app.example/',
} as const

const LOCAL_ORIGIN = 'http://127.0.0.1:8123'

// The owner UI's sign-in, which the menu hands every pick to. Default: the page
// is leaving for the authorization server, so there is nothing to show.
const connectMock =
  vi.fn<
    (url: string, server: { readonly wildflowerServer: boolean }) => Promise<string | undefined>
  >()

const WILDFLOWER_PROPS = {
  target: 'wildflower',
  connect: connectMock,
  localOrigin: LOCAL_ORIGIN,
} as const

const HOSTED_GROUP_NAME = 'Wildflower Health hosted server'

beforeEach(() => {
  vi.clearAllMocks()
  // Default: the SMART path, which in production redirects the page away.
  startStandaloneLaunchMock.mockResolvedValue({ kind: 'smart' })
  connectMock.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

/**
 * The names of the menu's server groups and forms, top to bottom. A selector,
 * not a role query: the preset groups are regions and the entries are forms,
 * and one query in document order is what shows their interleaving.
 */
const groupNames = (): readonly (string | null)[] =>
  Array.from(document.querySelectorAll('section[aria-label], form[aria-label]'), (group) =>
    group.getAttribute('aria-label')
  )

/** The hosted-server form, where a subdomain is entered. */
const hostedForm = (): HTMLElement => screen.getByRole('form', { name: HOSTED_GROUP_NAME })

/**
 * The local server's one button. Under `wildflower` it reads "Connect", like
 * the entries' own, so it is found inside its group.
 */
const localConnectButton = (): HTMLElement =>
  within(screen.getByRole('region', { name: 'Local Wildflower Server' })).getByRole('button', {
    name: 'Connect',
  })

/** Type `subdomain` into the hosted group and submit it. */
const connectToSubdomain = async (
  user: ReturnType<typeof userEvent.setup>,
  subdomain: string
): Promise<void> => {
  const hosted = within(hostedForm())
  await user.type(hosted.getByLabelText('Subdomain of wildflowerhealth.io'), subdomain)
  await user.click(hosted.getByRole('button', { name: 'Connect' }))
}

describe('ConnectMenu', () => {
  it('renders one button per preset, under its server group, and launches against the picked preset URL', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    // Every default group is a region labelled with the server's name that
    // shows the server's address and holds a button per preset. Assertions derive from the presets
    // themselves, so editing the list never silently outdates this test.
    for (const group of DEFAULT_SERVER_PRESET_GROUPS) {
      const region = within(screen.getByRole('region', { name: group.name }))
      expect(region.getByText(group.address)).toBeDefined()
      for (const preset of group.presets) {
        expect(region.getByRole('button', { name: preset.label })).toBeDefined()
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

  it.each([
    ['fhir-r4', <ConnectMenu key="fhir-r4" {...PROPS} />, 'Another FHIR R4 server'],
    [
      'wildflower',
      <ConnectMenu key="wildflower" {...WILDFLOWER_PROPS} />,
      'Another Wildflower server',
    ],
  ])(
    'lists the local server, then the hosted server, then the other presets, then free entry (%s)',
    (_target, menu, freeEntryName) => {
      render(menu)

      expect(groupNames()).toEqual([
        'Local Wildflower Server',
        HOSTED_GROUP_NAME,
        'Smart Health IT Demo Server',
        freeEntryName,
      ])
    }
  )

  it('slots the hosted server in after the leading run of Wildflower servers in custom presets', () => {
    const [local, smartHealthIt] = DEFAULT_SERVER_PRESET_GROUPS
    if (local === undefined || smartHealthIt === undefined) {
      throw new Error('expected the local and demo default groups')
    }
    const secondLocal = { ...local, name: 'Second Wildflower Server' }
    render(<ConnectMenu {...PROPS} presetGroups={[smartHealthIt, local, secondLocal]} />)

    // A non-Wildflower group first leaves no leading run, so the hosted group leads.
    expect(groupNames()).toEqual([
      HOSTED_GROUP_NAME,
      'Smart Health IT Demo Server',
      'Local Wildflower Server',
      'Second Wildflower Server',
      'Another FHIR R4 server',
    ])
  })

  it('leads with the hosted server when custom presets hold no Wildflower server', () => {
    const smartHealthIt = DEFAULT_SERVER_PRESET_GROUPS.find((group) => !group.wildflowerServer)
    if (smartHealthIt === undefined) throw new Error('expected a non-Wildflower default group')
    render(<ConnectMenu {...PROPS} presetGroups={[smartHealthIt]} />)

    expect(groupNames()).toEqual([
      HOSTED_GROUP_NAME,
      'Smart Health IT Demo Server',
      'Another FHIR R4 server',
    ])
  })

  it('follows every preset with the hosted server when custom presets hold only Wildflower servers', () => {
    const local = DEFAULT_SERVER_PRESET_GROUPS.find((group) => group.wildflowerServer)
    if (local === undefined) throw new Error('expected a Wildflower default group')
    const secondLocal = { ...local, name: 'Second Wildflower Server' }
    render(<ConnectMenu {...PROPS} presetGroups={[local, secondLocal]} />)

    expect(groupNames()).toEqual([
      'Local Wildflower Server',
      'Second Wildflower Server',
      HOSTED_GROUP_NAME,
      'Another FHIR R4 server',
    ])
  })

  it('launches against the normalized form of a valid free-entry URL', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    // A trailing slash the normalizer strips — the launch must see the canonical form.
    const freeEntry = within(screen.getByRole('form', { name: 'Another FHIR R4 server' }))
    await user.type(freeEntry.getByLabelText('FHIR base URL'), 'https://example.org/fhir/')
    await user.click(freeEntry.getByRole('button', { name: 'Connect' }))

    expect(startStandaloneLaunchMock).toHaveBeenCalledTimes(1)
    expect(startStandaloneLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ iss: 'https://example.org/fhir' })
    )
  })

  it('shows a validation message and does not launch on an invalid free entry', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    // A value the text input accepts but `normalizeServerUrl` rejects (no scheme).
    const freeEntry = within(screen.getByRole('form', { name: 'Another FHIR R4 server' }))
    await user.type(freeEntry.getByLabelText('FHIR base URL'), 'not-a-real-url')
    await user.click(freeEntry.getByRole('button', { name: 'Connect' }))

    // Beside the form it is about, not in the banner at the foot of the menu.
    expect(freeEntry.getByText(/valid http\(s\) FHIR base URL/i)).toBeDefined()
    expect(startStandaloneLaunchMock).not.toHaveBeenCalled()
  })

  it('surfaces an unreachable probe as an error banner, still allowing a retry', async () => {
    startStandaloneLaunchMock.mockResolvedValue({ kind: 'unreachable', message: 'Failed to fetch' })
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    await user.click(screen.getByRole('button', { name: 'Launch' }))

    await waitFor(() => {
      expect(screen.getByText(/Could not reach http:\/\/127\.0\.0\.1:8080\/fhir-r4/i)).toBeDefined()
    })
    // The menu is still there — the launch was attempted, and a retry is possible.
    expect(startStandaloneLaunchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Launch' })).toBeDefined()
  })

  it('launches against a hosted subdomain’s FHIR R4 base, trimmed and lower-cased', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...PROPS} />)

    await connectToSubdomain(user, '  Medication.Ruth ')

    expect(startStandaloneLaunchMock).toHaveBeenCalledTimes(1)
    expect(startStandaloneLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ iss: 'https://medication.ruth.wildflowerhealth.io/fhir-r4' })
    )
  })

  it.each(['', '-ruth', 'ruth.', 'ru..th', 'ruth/evil.example', 'evil.example@ruth'])(
    'shows a validation message and does not launch on the subdomain %j',
    async (subdomain) => {
      const user = userEvent.setup()
      render(<ConnectMenu {...PROPS} />)

      // `user.type` rejects an empty string, so the empty case only submits.
      if (subdomain === '') {
        await user.click(within(hostedForm()).getByRole('button', { name: 'Connect' }))
      } else {
        await connectToSubdomain(user, subdomain)
      }

      expect(within(hostedForm()).getByText(/Enter your server's subdomain/)).toBeDefined()
      expect(startStandaloneLaunchMock).not.toHaveBeenCalled()
    }
  )

  it('names the subdomain field for its domain, with a URL keyboard', () => {
    render(<ConnectMenu {...PROPS} />)

    const field = within(hostedForm()).getByRole('textbox', {
      name: 'Subdomain of wildflowerhealth.io',
    })
    expect(field.getAttribute('inputmode')).toBe('url')
  })

  it('spells the hosted address out to the FHIR base the app launches against', () => {
    render(<ConnectMenu {...PROPS} />)

    expect(within(hostedForm()).getByText('.wildflowerhealth.io/fhir-r4')).toBeDefined()
  })

  it('shows no server notice on the SMART app menu', () => {
    render(<ConnectMenu {...PROPS} />)

    expect(screen.queryByText(/Wildflower specific features/)).toBeNull()
  })
})

describe('ConnectMenu, signing in to a Wildflower server', () => {
  it("spells the hosted address out to the server's origin", () => {
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    expect(within(hostedForm()).getByText('.wildflowerhealth.io')).toBeDefined()
    expect(within(hostedForm()).queryByText(/\/fhir-r4/)).toBeNull()
  })

  it('signs in to the local server’s origin, as a Wildflower server', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    const local = within(screen.getByRole('region', { name: 'Local Wildflower Server' }))
    expect(local.getByText(LOCAL_ORIGIN)).toBeDefined()
    await user.click(local.getByRole('button', { name: 'Connect' }))

    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock).toHaveBeenCalledWith(LOCAL_ORIGIN, { wildflowerServer: true })
    expect(startStandaloneLaunchMock).not.toHaveBeenCalled()
  })

  it('signs in to a hosted subdomain’s origin, as a Wildflower server', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    await connectToSubdomain(user, 'ruth')

    expect(connectMock).toHaveBeenCalledWith('https://ruth.wildflowerhealth.io', {
      wildflowerServer: true,
    })
  })

  it('signs in to the demo server as a plain SMART server, under its notice', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    const demo = screen.getByRole('region', { name: 'Smart Health IT Demo Server' })
    expect(
      within(demo).getByText(
        "Wildflower specific features won't be available, but app launching should work."
      )
    ).toBeDefined()

    const [picked] = serverPresetGroupsFor('wildflower', LOCAL_ORIGIN)[1]?.presets ?? []
    if (picked === undefined) throw new Error('expected a demo server preset to click')
    await user.click(within(demo).getByRole('button', { name: picked.label }))

    expect(connectMock).toHaveBeenCalledWith(picked.url, { wildflowerServer: false })
  })

  it('signs in to the normalized form of a free-entry URL, as a Wildflower server', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    const freeEntry = within(screen.getByRole('form', { name: 'Another Wildflower server' }))
    await user.type(freeEntry.getByLabelText('Server URL'), 'https://my-server.example.com/')
    await user.click(freeEntry.getByRole('button', { name: 'Connect' }))

    expect(connectMock).toHaveBeenCalledWith('https://my-server.example.com', {
      wildflowerServer: true,
    })
  })

  it('shows a validation message worded for a server URL on an invalid free entry', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    const freeEntry = within(screen.getByRole('form', { name: 'Another Wildflower server' }))
    await user.type(freeEntry.getByLabelText('Server URL'), 'not-a-real-url')
    await user.click(freeEntry.getByRole('button', { name: 'Connect' }))

    expect(freeEntry.getByText(/valid http\(s\) server URL/i)).toBeDefined()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('does not sign in to an invalid subdomain', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    await connectToSubdomain(user, 'ruth/evil.example')

    expect(within(hostedForm()).getByText(/Enter your server's subdomain/)).toBeDefined()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('clears a subdomain’s validation message once a valid one connects', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    await connectToSubdomain(user, '-ruth')
    expect(within(hostedForm()).queryByText(/Enter your server's subdomain/)).not.toBeNull()

    await user.clear(within(hostedForm()).getByLabelText('Subdomain of wildflowerhealth.io'))
    await connectToSubdomain(user, 'ruth')

    expect(within(hostedForm()).queryByText(/Enter your server's subdomain/)).toBeNull()
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(connectMock).toHaveBeenCalledWith('https://ruth.wildflowerhealth.io', {
      wildflowerServer: true,
    })
  })

  it('shows the problem the sign-in reports, with the menu re-enabled for a retry', async () => {
    connectMock.mockResolvedValue('This server does not allow sign-in from this page.')
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    await user.click(localConnectButton())

    await waitFor(() => {
      expect(screen.getByText('This server does not allow sign-in from this page.')).toBeDefined()
    })
    expect(localConnectButton().hasAttribute('disabled')).toBe(false)
  })

  it('shows a rejected sign-in’s message', async () => {
    connectMock.mockRejectedValue(new Error('discovery failed'))
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    await user.click(localConnectButton())

    await waitFor(() => {
      expect(screen.getByText('discovery failed')).toBeDefined()
    })
  })

  it('stays disabled once the sign-in is leaving the page, so a second click cannot start another', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)

    await user.click(localConnectButton())
    // Let the sign-in settle, and the menu handle its `undefined`, before looking.
    await act(async () => {
      await connectMock.mock.results[0]?.value
    })

    expect(localConnectButton().hasAttribute('disabled')).toBe(true)
    expect(connectMock).toHaveBeenCalledTimes(1)
  })

  it('comes back usable when the browser restores the page from its back-forward cache', async () => {
    const user = userEvent.setup()
    render(<ConnectMenu {...WILDFLOWER_PROPS} />)
    await user.click(localConnectButton())
    await act(async () => {
      await connectMock.mock.results[0]?.value
    })

    // An ordinary `pageshow` (a fresh load) is not a restore: still leaving.
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    })
    expect(localConnectButton().hasAttribute('disabled')).toBe(true)

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    expect(localConnectButton().hasAttribute('disabled')).toBe(false)
  })

  it('is disabled while the page has a sign-in of its own in flight, and re-enabled after', () => {
    const { rerender } = render(<ConnectMenu {...WILDFLOWER_PROPS} busy />)

    expect(localConnectButton().hasAttribute('disabled')).toBe(true)
    expect(
      within(screen.getByRole('form', { name: HOSTED_GROUP_NAME }))
        .getByRole('button', { name: 'Connect' })
        .hasAttribute('disabled')
    ).toBe(true)

    rerender(<ConnectMenu {...WILDFLOWER_PROPS} busy={false} />)

    expect(localConnectButton().hasAttribute('disabled')).toBe(false)
  })
})
