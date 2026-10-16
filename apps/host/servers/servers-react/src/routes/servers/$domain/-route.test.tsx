import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../../../../servers-wire-golden.json' with { type: 'json' }
import {
  type FakeEvents,
  type FakeHost,
  type SeenInvoke,
  fakeEvents,
  fakeHealth,
  hostWith,
} from '../../../test-utils/host-fakes.ts'
import {
  openDialogOrThrow,
  renderBase,
  storageAnswered,
  setUpEachBaseTest,
} from '../../../test-utils/render-base.ts'
import {
  hero,
  heroBadge,
  listedWithRuthStatus,
  openTab,
  openTabName,
  passingReport,
  renderServerPage,
} from './-server-page-test-utils.ts'

setUpEachBaseTest()

describe('the server page', () => {
  it.each([
    ['Access', 'a request waits', 'runningWithAPendingConsent'],
    ['Status', 'nothing waits', 'runningAndReachable'],
  ] as const)('should open on its %s tab when %s', async (tabName, _, statusName) => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
    })

    // Assert
    expect(await openTabName()).toBe(tabName)
  })

  it('should open the tab its path names', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      tab: 'relay',
      servers: listedWithRuthStatus(golden.serverStatuses.runningWithAPendingConsent),
    })

    // Assert
    expect(await openTabName()).toBe('Relay')
    expect(await screen.findByRole('heading', { name: 'Relay and tunnel' })).toBeDefined()
  })

  it("should open from a card's Edit, show the server's details, and go back to the list", async () => {
    // Arrange
    const user = userEvent.setup()
    renderBase({
      invoke: hostWith({ servers: () => Promise.resolve(golden.listedServers) }).invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      httpClient: fakeHealth(() => Response.json(passingReport)).layer,
    })
    const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })

    // Act
    await user.click(within(ruth).getByRole('link', { name: 'Edit' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Server' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'ruth.relay.example.com' })).toBeDefined()
    expect(await openTabName()).toBe('Status')
    expect(screen.getByRole('heading', { name: 'Connection' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.queryByLabelText('App launcher')).toBeNull()

    // Act
    await openTab('Default Apps')

    // Assert
    expect(screen.getByLabelText('App launcher')).toHaveProperty(
      'value',
      'https://launcher.wildflowerhealth.io/'
    )
    expect(screen.getByLabelText('Authorization')).toBeDefined()

    // Act
    await openTab('Relay')

    // Assert
    expect(
      screen.getByText('Self-hosted Wildflower relay at https://relay.example.com/')
    ).toBeDefined()
    expect(screen.getByText('ruth')).toBeDefined()
    expect(screen.queryByLabelText('App launcher')).toBeNull()

    // Act
    await openTab('Certificate')

    // Assert
    expect(screen.getByText("Let's Encrypt")).toBeDefined()

    // Act
    await openTab('Destructive actions')

    // Assert
    expect(screen.getByRole('heading', { name: 'Destructive actions' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()

    // Act
    await user.click(screen.getByRole('link', { name: 'Servers' }))

    // Assert
    expect(await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })).toBeDefined()
  })

  it("should show the host's error when it can't read the servers, and open the page on retry", async () => {
    // Arrange
    const user = userEvent.setup()
    let answer: () => Promise<unknown> = () => Promise.reject(golden.commandErrors[1])
    const host = hostWith({ servers: () => answer() })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: '/servers/ruth.relay.example.com',
    })

    // Assert
    expect(
      await screen.findByRole('heading', { name: "The servers on this device couldn't be read" })
    ).toBeDefined()
    expect(screen.getByRole('link', { name: 'Servers' })).toBeDefined()

    // Act
    answer = () => Promise.resolve(golden.listedServers)
    await user.click(screen.getByRole('button', { name: /retry/i }))

    // Assert
    expect(await openTabName()).toBe('Status')
  })

  it('should say so for a domain the device has no server at', async () => {
    // Act
    renderServerPage({ domain: 'gone.relay.example.com' })

    // Assert
    expect(await screen.findByText('This device has no server at this address.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it.each([
    ['startingUnchecked', 'Starting', false],
    ['runningAndReachable', 'Running', true],
    ['runningUnreachable', 'Running, not reachable yet', true],
    ['runningTokenRejected', "The relay rejected this server's tunnel token", true],
    ['stoppedWithAnError', 'Stopped', false],
  ] as const)(
    'should show a %s status in the hero as "%s", with its start only while running',
    async (statusName, label, running) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
      })

      // Assert
      expect((await heroBadge()).textContent).toMatch(new RegExp(`${label}$`))
      expect(within(await hero()).queryByText(/^Since /) !== null).toBe(running)
    }
  )

  it('should show the domain and status as its title, with no run policy, Launch or Authorization', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      servers: [
        { ...golden.listedServers[0], runPolicy: { kind: 'always' } },
        golden.listedServers[1],
      ],
    })

    // Assert
    const heroRegion = await hero()
    expect(
      within(heroRegion)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['ruth.relay.example.com'])
    expect(heroRegion.textContent).not.toContain('Always on')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('should copy the domain when it is tapped, and say so, or that the clipboard refused', async () => {
    // Arrange
    const user = userEvent.setup()
    renderServerPage({ domain: 'ruth.relay.example.com' })
    const heading = within(await hero()).getByRole('heading', { name: 'ruth.relay.example.com' })
    const domain = within(heading).getByRole('button', { name: 'ruth.relay.example.com' })

    // Act
    await user.click(domain)

    // Assert
    expect(await navigator.clipboard.readText()).toBe('ruth.relay.example.com')
    expect(
      within(await hero())
        .getByText('Copied')
        .getAttribute('role')
    ).toBe('status')

    // Act
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('not allowed'))
    await user.click(domain)

    // Assert
    expect(
      await screen.findByText('The clipboard refused. Select the domain to copy it by hand.')
    ).toBeDefined()
  })

  describe('a start-and-launch begun on its card', () => {
    const LAB = 'lab.rathole.example.com'

    /**
     * The device's clock while these tests run, so the time "Start and launch"
     * is confirmed: after every golden status's stop, and before the stops the
     * tests send during a wait.
     */
    const NOW = '2026-10-06T17:50:00Z'

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(NOW) })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** The list item of the server `domain`. */
    const serverRow = (domain: string): HTMLElement =>
      screen.getByRole('listitem', { name: domain })

    /** The Launch button, labelled Apps, on the server `domain`'s card. */
    const launchOn = (domain: string): HTMLButtonElement => {
      const button = within(serverRow(domain)).getByRole('button', { name: 'Apps' })
      if (!(button instanceof HTMLButtonElement)) throw new Error('Launch is no <button>')
      return button
    }

    /** `golden.serverStatuses.runningAndReachable`, for the server `domain`. */
    const launchableStatus = (domain: string): Readonly<Record<string, unknown>> => ({
      ...golden.serverStatuses.runningAndReachable,
      domain,
    })

    /** The servers' list, and the host and events they were rendered with. */
    const renderLaunching = ({
      servers = golden.listedServers,
      answers = {},
      events = fakeEvents(),
    }: {
      readonly servers?: readonly unknown[]
      readonly answers?: Readonly<Record<string, () => Promise<unknown>>>
      readonly events?: FakeEvents
    }): { readonly host: FakeHost; readonly events: FakeEvents } => {
      const host = hostWith({ servers: () => Promise.resolve(servers), answers })
      renderBase({
        invoke: host.invoke,
        storage: storageAnswered({ crashReports: false, performance: false }),
        events,
      })
      return { host, events }
    }

    /** The `server_launch` invokes `host` saw. */
    const launchesSeen = (host: FakeHost): readonly SeenInvoke[] =>
      host.seen.filter(({ command }) => command === 'server_launch')

    /** Confirm Start and launch on the server `domain`'s card, and wait for Starting…. */
    const startAndLaunch = async (
      user: ReturnType<typeof userEvent.setup>,
      domain: string
    ): Promise<void> => {
      await screen.findByRole('listitem', { name: domain })
      await user.click(launchOn(domain))
      await user.click(
        within(openDialogOrThrow()).getByRole('button', { name: 'Start and launch' })
      )
      await within(serverRow(domain)).findByRole('button', { name: 'Starting…' })
    }

    it("should keep waiting while Edit has the server's page open, and launch from there", async () => {
      // Arrange
      const user = userEvent.setup()
      const { host, events } = renderLaunching({
        answers: {
          server_set_run_policy: () => Promise.resolve({ kind: 'whileOpen' }),
          server_launch: () => Promise.resolve(null),
        },
      })
      await startAndLaunch(user, LAB)

      // Act
      await user.click(within(serverRow(LAB)).getByRole('link', { name: 'Edit' }))

      // Assert
      expect(await screen.findByRole('region', { name: 'Status' })).toBeDefined()
      expect(launchesSeen(host)).toEqual([])

      // Act
      events.emit('server-status', launchableStatus(LAB))

      // Assert
      await waitFor(() => {
        expect(launchesSeen(host)).toEqual([{ command: 'server_launch', args: { domain: LAB } }])
      })
    })
  })
})
