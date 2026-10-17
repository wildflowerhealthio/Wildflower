import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import type { HostPlatform } from '@wildflowerhealthio/servers-core-js'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import { formatInstant } from './server-status-text.ts'
import {
  type FakeEvents,
  type FakeHost,
  type SeenInvoke,
  fakeEvents,
  fakeHost,
  fakeTaps,
  hostWith,
  steadyAnswers,
} from './test-utils/host-fakes.ts'
import {
  BACKGROUND_SERVICE_START_CONFIG,
  BASE_DSN,
  initConsentedTelemetryMock,
  mapConsentStorage,
  openDialog,
  openDialogOrThrow,
  paragraphsOf,
  redactServerHostMock,
  renderBase,
  setUpEachBaseTest,
  storageAnswered,
} from './test-utils/render-base.ts'

setUpEachBaseTest()

describe('BaseGate', () => {
  it('should show only the consent dialog, and call no host command, until the user answers', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = hostWith()

    // Act
    renderBase({ invoke: host.invoke, storage: mapConsentStorage() })

    // Assert
    await waitFor(() => {
      expect(openDialog()).not.toBeNull()
    })
    expect(screen.queryByRole('heading', { name: 'Servers' })).toBeNull()
    expect(host.seen).toEqual([])

    // Act
    await user.click(
      screen.getByRole('button', { name: WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY.continueLabel })
    )

    // Assert
    expect(await screen.findByRole('heading', { name: 'Servers' })).toBeDefined()
    expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(1)
    const [{ consent, tags }] = initConsentedTelemetryMock.mock.calls[0]
    expect(consent).toMatchObject({ crashReports: false, performance: false })
    expect(tags).toStrictEqual({ app: 'host-app' })
  })

  it('should start telemetry with the base DSN from a stored answer, without the dialog', async () => {
    // Arrange
    const host = hostWith()

    // Act
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: true, performance: false }),
    })

    // Assert
    expect(await screen.findByRole('heading', { name: 'Servers' })).toBeDefined()
    expect(openDialog()).toBeNull()
    expect(initConsentedTelemetryMock).toHaveBeenCalled()
    const [{ consent, config, tags }] = initConsentedTelemetryMock.mock.calls[0]
    expect(consent).toMatchObject({ crashReports: true, performance: false })
    expect(config.sentry.dsn).toBe(BASE_DSN)
    expect(config.otel.serviceName).toBe('host-app')
    expect(tags).toStrictEqual({ app: 'host-app' })
  })

  it('should show the empty server list, and reach Host Settings from it', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = hostWith()
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })

    // Assert
    expect(await screen.findByText('No servers yet')).toBeDefined()

    // Act
    await user.click(screen.getByRole('link', { name: 'Host Settings' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Host Settings' })).toBeDefined()

    // Act
    await user.click(screen.getByRole('link', { name: 'Servers' }))

    // Assert
    expect(await screen.findByText('No servers yet')).toBeDefined()
  })
})

describe('the background session recovery', () => {
  it("should be enabled with the host's start config once the user has answered", async () => {
    // Arrange
    const host = hostWith()

    // Act
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })

    // Assert
    await waitFor(() => {
      expect(host.seen).toContainEqual({
        command: 'plugin:background-service|configure_recovery',
        args: { enabled: true, config: BACKGROUND_SERVICE_START_CONFIG },
      })
    })
  })
})

describe('a tapped notification', () => {
  it('should ask the host to open the consent it announced', async () => {
    // Arrange
    const host = hostWith({
      answers: { server_open_notified_consent: () => Promise.resolve(null) },
    })
    const taps = fakeTaps()
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      taps,
    })
    await screen.findByText('No servers yet')

    // Act
    act(() => {
      taps.tap({ actionId: 'tap', notification: { id: 1_534_013_825, title: 'Access request' } })
    })

    // Assert
    await waitFor(() => {
      expect(host.seen).toContainEqual({
        command: 'server_open_notified_consent',
        args: { notificationId: 1_534_013_825 },
      })
    })
  })

  it('should open nothing for a tap that does not decode', async () => {
    // Arrange
    const host = hostWith()
    const taps = fakeTaps()
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      taps,
    })
    await screen.findByText('No servers yet')

    // Act
    act(() => {
      taps.tap({ notification: {} })
    })

    // Assert
    expect(host.seen.map(({ command }) => command)).not.toContain('server_open_notified_consent')
  })
})

describe('the server list', () => {
  /** The list item of the server `domain`. */
  const serverRow = (domain: string): HTMLElement => screen.getByRole('listitem', { name: domain })

  /** The run-policy control of the server `domain`, and the label its selection shows. */
  const runPolicyOf = (
    domain: string
  ): { readonly control: HTMLSelectElement; readonly shown: string } => {
    const control = within(serverRow(domain)).getByRole('combobox')
    if (!(control instanceof HTMLSelectElement)) throw new Error('the control is no <select>')
    return { control, shown: control.selectedOptions[0]?.textContent ?? '' }
  }

  /** `golden.listedServers` with the first server's run policy set to `runPolicy`. */
  const listedWithRuthPolicy = (runPolicy: unknown): readonly unknown[] => [
    { ...golden.listedServers[0], runPolicy },
    golden.listedServers[1],
  ]

  const renderListed = (
    servers: readonly unknown[],
    events = fakeEvents(),
    platform: HostPlatform.Type = 'desktop'
  ): FakeHost => {
    const host = hostWith({ servers: () => Promise.resolve(servers) })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      platform,
      events,
    })
    return host
  }

  it("should redact each listed server's domain from telemetry", async () => {
    // Arrange
    redactServerHostMock.mockClear()

    // Act
    renderListed(golden.listedServers)

    // Assert
    await waitFor(() => {
      expect(redactServerHostMock.mock.calls).toStrictEqual(
        golden.listedServers.map((server) => [server.domain])
      )
    })
  })

  it('should say what a server is, and offer Add server, when there are none', async () => {
    // Act
    renderListed([])

    // Assert
    expect(await screen.findByText('No servers yet')).toBeDefined()
    expect(screen.getByText(/^A server keeps your health records on this device/)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Add new server' }).getAttribute('href')).toBe(
      '/servers/new'
    )
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it.each([
    ['one server', [golden.listedServers[0]]],
    ['several servers', golden.listedServers],
  ] as const)('should show a card, with Launch and Edit, for each of %s', async (_, servers) => {
    // Act
    renderListed(servers)

    // Assert
    await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(screen.getAllByRole('listitem').map((card) => card.getAttribute('aria-label'))).toEqual(
      servers.map((server) => server.domain)
    )
    for (const card of screen.getAllByRole('listitem')) {
      const apps = within(card).getByRole('button', { name: 'Apps' })
      expect(apps).toHaveProperty('disabled', false)
      expect(apps.getAttribute('title')).toBe("Open this server's app launcher")
      expect(within(card).getByRole('link', { name: 'Edit' })).toBeDefined()
    }
    expect(screen.getByRole('link', { name: 'Add new server' }).getAttribute('href')).toBe(
      '/servers/new'
    )
  })

  it.each([
    ['runningAndReachable', 'Running', 'success'],
    ['startingUnchecked', 'Starting', 'info'],
    ['runningUnreachable', 'Running, not reachable yet', 'warning'],
    ['runningReconnecting', 'Running, reconnecting to the relay', 'warning'],
    ['runningTokenRejected', "The relay rejected this server's tunnel token", 'danger'],
    ['runningTunnelUnknown', 'The relay has no tunnel for this server', 'danger'],
    ['neverRun', 'Stopped', 'neutral'],
    ['stoppedWithAnError', 'Stopped', 'danger'],
  ] as const)(
    'should merge a %s status into the dot "%s", in the %s tone',
    async (statusName, label, tone) => {
      // Act
      renderListed([
        { ...golden.listedServers[0], status: golden.serverStatuses[statusName] },
        golden.listedServers[1],
      ])

      // Assert
      const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
      expect(within(ruth).getByRole('img', { name: label })).toBeDefined()
      expect(ruth.dataset['tone']).toBe(tone)
    }
  )

  it.each([
    ['runningAndReachable', null],
    ['startingUnchecked', 'Starting'],
    ['runningUnreachable', 'Running, not reachable yet: the relay answered 502'],
    ['runningRenewalFailed', 'Running, checking it can be reached'],
    ['runningReconnecting', 'Running, reconnecting to the relay: the relay closed the connection'],
    [
      'runningTokenRejected',
      "The relay rejected this server's tunnel token. Enter a new token on the Relay tab of the server's page.",
    ],
    [
      'runningTunnelUnknown',
      'The relay has no tunnel for this server. The tunnel ruth may have been deleted. Check the tunnel name, or ask whoever runs the relay.',
    ],
    ['neverRun', null],
    ['stoppedWithAnError', null],
  ] as const)('should note a %s status under the picker as %j', async (statusName, note) => {
    // Act
    renderListed([
      { ...golden.listedServers[0], status: golden.serverStatuses[statusName] },
      golden.listedServers[1],
    ])

    // Assert
    const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    const notes = within(ruth)
      .queryAllByText(
        /^(Running|Starting|Stopped|The relay rejected this|The relay has no tunnel for)/,
        { selector: 'p' }
      )
      .map((paragraph) => paragraph.textContent)
    expect(notes).toEqual(note === null ? [] : [note])
  })

  /** `golden.serverStatuses[statusName]` with its certificate's status set to `certificateStatus` and none held. */
  const withNoCertificateHeld = (
    statusName: 'runningAndReachable' | 'neverRun',
    certificateStatus: string
  ): unknown => {
    const status = golden.serverStatuses[statusName]
    return {
      ...status,
      certificate: { status: certificateStatus, issuer: status.certificate.issuer },
    }
  }

  it.each([
    [
      'running, ordering with no certificate held',
      withNoCertificateHeld('runningAndReachable', 'ordering'),
      true,
    ],
    [
      'running, its order failing',
      withNoCertificateHeld('runningAndReachable', 'orderFailing'),
      false,
    ],
    ['running, holding a valid certificate', golden.serverStatuses.runningAndReachable, false],
    ['stopped, holding none', withNoCertificateHeld('neverRun', 'notIssued'), false],
  ] as const)(
    "should warn above the buttons that a server can't be reached until its certificate arrives only while it runs ordering with none held: %s",
    async (_, status, warns) => {
      // Act
      renderListed([{ ...golden.listedServers[0], status }, golden.listedServers[1]])

      // Assert
      const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
      const warning = within(ruth).queryByText(
        "This server can't be reached until its certificate arrives."
      )
      expect(warning !== null).toBe(warns)
      if (warning !== null) {
        const apps = within(ruth).getByRole('button', { name: 'Apps' })
        expect(
          warning.compareDocumentPosition(apps) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
      }
    }
  )

  it.each([
    [{ kind: 'off' }, /^Off$/],
    [{ kind: 'whileOpen' }, /^On while Wildflower is open$/],
    [{ kind: 'until', at: '2999-01-01T00:00:00Z' }, /^On for \d+ h — until \S/],
    [{ kind: 'until', at: '2026-10-06T17:42:00Z' }, /^Ended at \S/],
    [{ kind: 'always' }, /^Always on$/],
  ] as const)('should say when a server runs for the policy %j', async (runPolicy, expected) => {
    // Act
    renderListed(listedWithRuthPolicy(runPolicy))

    // Assert
    await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(
      within(serverRow('ruth.relay.example.com')).getByText(expected, { selector: 'span' })
    ).toBeDefined()
  })

  it("should show a stopped server's error", async () => {
    // Act
    renderListed(golden.listedServers)

    // Assert
    const lab = await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })
    expect(within(lab).getByRole('img', { name: 'Stopped' })).toBeDefined()
    expect(
      within(lab).getByText("It stopped with an error: the server's config couldn't be built")
    ).toBeDefined()
    expect(runPolicyOf('lab.rathole.example.com').shown).toBe('Off')
  })

  it('should show an until that has passed as ended, and one ahead as on', async () => {
    // Act
    renderListed(golden.listedServers)

    // Assert
    await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(runPolicyOf('ruth.relay.example.com').shown).toMatch(/^Ended at /)
    cleanup()

    // Act
    renderListed(listedWithRuthPolicy({ kind: 'until', at: '2999-01-01T00:00:00Z' }))

    // Assert
    await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(runPolicyOf('ruth.relay.example.com').shown).toMatch(/^On for /)
  })

  it("should say a live until's time left, rounded up, and its deadline, and that it ended once the deadline passes", async () => {
    // Arrange
    const now = Date.parse('2026-10-15T17:00:00Z')
    const deadline = DateTime.unsafeMake(now + 61 * 60_000)
    const until = `until ${formatInstant(deadline)}`
    /** The text of the field on Ruth's card. */
    const fieldText = (): string | null =>
      within(serverRow('ruth.relay.example.com')).getByText(/^(On for|Ended at) /, {
        selector: 'span',
      }).textContent
    /** Move the clock on by `millis`, and let the field tick. */
    const advance = (millis: number): void => {
      act(() => {
        vi.advanceTimersByTime(millis)
      })
    }
    vi.useFakeTimers({ shouldAdvanceTime: true, now })
    try {
      // Act
      renderListed(listedWithRuthPolicy({ kind: 'until', at: DateTime.formatIso(deadline) }))

      // Assert
      await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
      expect(fieldText()).toBe(`On for 2 h — ${until}`)
      expect(runPolicyOf('ruth.relay.example.com').shown).toBe(`On for 2 h — ${until}`)

      // Act
      advance(2 * 60_000)

      // Assert
      expect(fieldText()).toBe(`On for 59 min — ${until}`)

      // Act
      advance(58 * 60_000 + 30_000)

      // Assert
      expect(fieldText()).toBe(`On for 1 min — ${until}`)

      // Act
      advance(30_000)

      // Assert
      expect(fieldText()).toBe(`Ended at ${formatInstant(deadline)}`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('should read the clock again as the page is shown, though its timers were held back', async () => {
    // Arrange
    const now = Date.parse('2026-10-15T17:00:00Z')
    const deadline = DateTime.unsafeMake(now + 15 * 60_000)
    vi.useFakeTimers({ now })
    try {
      renderListed(listedWithRuthPolicy({ kind: 'until', at: DateTime.formatIso(deadline) }))
      await vi.waitFor(() => {
        expect(runPolicyOf('ruth.relay.example.com').shown).toMatch(/^On for 15 min /)
      })

      // Act: the phone suspended the app past the deadline, its timers with it.
      vi.setSystemTime(now + 20 * 60_000)
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      // Assert
      expect(runPolicyOf('ruth.relay.example.com').shown).toBe(
        `Ended at ${formatInstant(deadline)}`
      )
    } finally {
      vi.useRealTimers()
    }
  })

  /** What the note above the run-policy field says on each phone. */
  const PHONE_NOTES = {
    android:
      'On Android, the server keeps running only while Wildflower is open, and for 2 minutes after you leave.',
    ios: 'On iOS, the server runs while Wildflower is open and for about 25 seconds after you leave; after that, only in short spells iOS allows now and then.',
  } as const

  it.each([
    ['ios', { kind: 'always' }, true],
    ['android', { kind: 'always' }, true],
    ['ios', { kind: 'until', at: '2999-01-01T00:00:00Z' }, true],
    ['android', { kind: 'until', at: '2999-01-01T00:00:00Z' }, true],
    ['ios', { kind: 'until', at: '2026-10-06T17:42:00Z' }, false],
    ['android', { kind: 'whileOpen' }, false],
    ['ios', { kind: 'off' }, false],
    ['desktop', { kind: 'always' }, false],
    ['desktop', { kind: 'until', at: '2999-01-01T00:00:00Z' }, false],
  ] as const)(
    "on %s, for the policy %j, should show the phone's note above the field, describing it: %s",
    async (platform, runPolicy, shown) => {
      // Act
      renderListed(listedWithRuthPolicy(runPolicy), fakeEvents(), platform)

      // Assert
      await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
      const row = within(serverRow('ruth.relay.example.com'))
      const notes = Object.values(PHONE_NOTES).flatMap((text) => row.queryAllByText(text))
      expect(notes.length).toBe(shown ? 1 : 0)
      if (platform === 'desktop' || !shown) {
        expect(runPolicyOf('ruth.relay.example.com').control.getAttribute('aria-describedby')).toBe(
          null
        )
        return
      }
      const note = row.getByText(PHONE_NOTES[platform])
      expect(row.getByRole('combobox', { description: PHONE_NOTES[platform] })).toBe(
        runPolicyOf('ruth.relay.example.com').control
      )
      expect(
        note.compareDocumentPosition(runPolicyOf('ruth.relay.example.com').control) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0)
    }
  )

  it("should show the host's error when it can't read the servers, and read them again on retry", async () => {
    // Arrange
    const user = userEvent.setup()
    let answer: () => Promise<unknown> = () => Promise.reject(golden.commandErrors[1])
    const host = hostWith({ servers: () => answer() })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })

    // Assert
    expect(
      await screen.findByRole('heading', { name: "The servers on this device couldn't be read" })
    ).toBeDefined()
    expect(screen.getByText(new RegExp(golden.commandErrors[1].message))).toBeDefined()

    // Act
    answer = () => Promise.resolve([])
    await user.click(screen.getByRole('button', { name: /retry/i }))

    // Assert
    expect(await screen.findByText('No servers yet')).toBeDefined()
  })

  it('should show each server-status event in place of the listed status', async () => {
    // Arrange
    const events = fakeEvents()
    renderListed(golden.listedServers, events)
    const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })

    // Act
    events.emit('server-status', golden.serverStatuses.stoppedByThePlatform)

    // Assert
    expect(
      await within(ruth).findByText('The system ended its time in the background.')
    ).toBeDefined()
    expect(within(ruth).queryByRole('img', { name: 'Running' })).toBeNull()
  })

  it('should keep a server-status event over a read of the list that was in flight when it came', async () => {
    // Arrange
    const events = fakeEvents()
    const stopped = [
      { ...golden.listedServers[0], status: golden.serverStatuses.stoppedByThePlatform },
      golden.listedServers[1],
    ]
    const inFlightReads: Array<(servers: readonly unknown[]) => void> = []
    let readsAnswered = 0
    const host = hostWith({
      servers: () => {
        readsAnswered += 1
        // The first read answers at once; the second, for a server the list
        // doesn't hold, is held, so ruth's event arrives while it is in flight.
        if (readsAnswered === 1) return Promise.resolve(golden.listedServers)
        if (readsAnswered === 2) {
          return new Promise((resolve) => {
            inFlightReads.push(resolve)
          })
        }
        return Promise.resolve(stopped)
      },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      events,
    })
    const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    events.emit('server-status', {
      ...golden.serverStatuses.stoppedByThePlatform,
      domain: 'new.relay.example.com',
    })
    await waitFor(() => {
      expect(inFlightReads).toHaveLength(1)
    })

    // Act
    events.emit('server-status', golden.serverStatuses.stoppedByThePlatform)
    inFlightReads[0]?.(golden.listedServers)

    // Assert
    expect(
      await within(ruth).findByText('The system ended its time in the background.')
    ).toBeDefined()
    await waitFor(() => {
      expect(host.seen.filter(({ command }) => command === 'servers_list')).toHaveLength(3)
    })
    expect(within(ruth).queryByRole('img', { name: 'Running' })).toBeNull()
  })

  it('should offer the run-policy presets', async () => {
    // Act
    renderListed(golden.listedServers)

    // Assert
    await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })
    expect(
      Array.from(runPolicyOf('lab.rathole.example.com').control.options, (option) => option.text)
    ).toEqual([
      'Off',
      'While Wildflower is open',
      'For 15 minutes',
      'For 1 hour',
      'For 8 hours',
      'Always',
    ])
  })

  it.each([
    ['Off', { kind: 'off' }],
    ['While Wildflower is open', { kind: 'whileOpen' }],
    ['For 15 minutes', { kind: 'for', seconds: 15 * 60 }],
    ['For 1 hour', { kind: 'for', seconds: 60 * 60 }],
    ['For 8 hours', { kind: 'for', seconds: 8 * 60 * 60 }],
    ['Always', { kind: 'always' }],
  ] as const)('should send the choice of "%s" as %j', async (label, choice) => {
    // Arrange
    const user = userEvent.setup()
    const host = hostWith({
      servers: () => Promise.resolve(golden.listedServers),
      answers: { server_set_run_policy: () => Promise.resolve({ kind: 'always' }) },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })
    await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })

    // Act
    await user.selectOptions(runPolicyOf('ruth.relay.example.com').control, label)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_set_run_policy',
      args: { domain: 'ruth.relay.example.com', choice },
    })
  })

  it('should say that launching needs a connection while the webview is offline, and still reach the host', async () => {
    // Arrange
    const user = userEvent.setup()
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const offlineNotice = "You're offline. Apps open from the web, so launching needs a connection."
    try {
      // Act
      const host = renderListed(golden.listedServers)

      // Assert
      expect(await screen.findByText(offlineNotice)).toBeDefined()
      expect(await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })).toBeDefined()

      // Act
      onLine.mockReturnValue(true)
      act(() => {
        window.dispatchEvent(new Event('online'))
      })

      // Assert
      expect(screen.queryByText(offlineNotice)).toBeNull()

      // Act
      onLine.mockReturnValue(false)
      act(() => {
        window.dispatchEvent(new Event('offline'))
      })

      // Assert
      expect(screen.getByText(offlineNotice)).toBeDefined()

      // Act
      await user.selectOptions(runPolicyOf('lab.rathole.example.com').control, 'Always')

      // Assert
      await waitFor(() => {
        expect(host.seen.map(({ command }) => command)).toContain('server_set_run_policy')
      })
    } finally {
      onLine.mockRestore()
      // TanStack Query's online manager heard the events too.
      act(() => {
        window.dispatchEvent(new Event('online'))
      })
    }
  })

  it('should set the run policy the user picks, and show the one the host stored', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = hostWith({
      servers: () => Promise.resolve(golden.listedServers),
      answers: { server_set_run_policy: () => Promise.resolve({ kind: 'always' }) },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })
    await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })

    // Act
    await user.selectOptions(runPolicyOf('lab.rathole.example.com').control, 'For 1 hour')

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_set_run_policy',
      args: { domain: 'lab.rathole.example.com', choice: { kind: 'for', seconds: 3600 } },
    })
    await waitFor(() => {
      expect(runPolicyOf('lab.rathole.example.com').shown).toBe('Always')
    })
  })

  it('should show the policy a choice becomes before the host answers', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = hostWith({
      servers: () => Promise.resolve(golden.listedServers),
      answers: { server_set_run_policy: () => new Promise(() => {}) },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })
    await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })

    // Act
    await user.selectOptions(runPolicyOf('lab.rathole.example.com').control, 'For 1 hour')

    // Assert
    await waitFor(() => {
      expect(runPolicyOf('lab.rathole.example.com').shown).toMatch(/^On for 1 h — until /)
    })
    expect(
      within(serverRow('lab.rathole.example.com')).getByText(/^On for 1 h — until \S/, {
        selector: 'span',
      })
    ).toBeDefined()
    expect(runPolicyOf('lab.rathole.example.com').control.disabled).toBe(true)
    expect(runPolicyOf('ruth.relay.example.com').control.disabled).toBe(false)
  })

  it("should put the previous policy back, and show the host's refusal on its card, when the host refuses", async () => {
    // Arrange
    const user = userEvent.setup()
    const host = hostWith({
      servers: () => Promise.resolve(golden.listedServers),
      answers: { server_set_run_policy: () => Promise.reject(golden.commandErrors[0]) },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })
    await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })

    // Act
    await user.selectOptions(runPolicyOf('lab.rathole.example.com').control, 'Always')

    // Assert
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain(golden.commandErrors[0].message)
    expect(banner.closest('li')).toBe(serverRow('lab.rathole.example.com'))
    expect(runPolicyOf('lab.rathole.example.com').shown).toBe('Off')
    expect(runPolicyOf('lab.rathole.example.com').control.disabled).toBe(false)
  })
})

describe('Launch', () => {
  const RUTH = 'ruth.relay.example.com'
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
  const serverRow = (domain: string): HTMLElement => screen.getByRole('listitem', { name: domain })

  /** The Launch button, labelled Apps, on the server `domain`'s card. */
  const launchOn = (domain: string): HTMLButtonElement => {
    const button = within(serverRow(domain)).getByRole('button', { name: 'Apps' })
    if (!(button instanceof HTMLButtonElement)) throw new Error('Launch is no <button>')
    return button
  }

  /** The text of the element that describes `button`, if any. */
  const descriptionOf = (button: HTMLElement): string | null | undefined =>
    document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent

  /** Whether `first` comes before `second` in the document. */
  const isBefore = (first: Node, second: Node): boolean =>
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  /** `golden.serverStatuses.runningAndReachable`, for the server `domain`. */
  const launchableStatus = (domain: string): Readonly<Record<string, unknown>> => ({
    ...golden.serverStatuses.runningAndReachable,
    domain,
  })

  /** `golden.listedServers` with lab's run policy and status replaced. */
  const listedWithLab = ({
    runPolicy = golden.listedServers[1].runPolicy,
    status = golden.listedServers[1].status,
  }: {
    readonly runPolicy?: unknown
    readonly status?: { readonly certificate: unknown; readonly [key: string]: unknown }
  }): readonly unknown[] => [
    golden.listedServers[0],
    { ...golden.listedServers[1], runPolicy, status, certificate: status.certificate },
  ]

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

  const launchesSeen = (host: FakeHost): readonly SeenInvoke[] =>
    host.seen.filter(({ command }) => command === 'server_launch')

  it("should launch a launchable server, and show the host's refusal", async () => {
    // Arrange
    const user = userEvent.setup()
    const { host } = renderLaunching({
      answers: { server_launch: () => Promise.reject(golden.launchErrors[2]) },
    })
    await screen.findByRole('listitem', { name: RUTH })

    // Act
    await user.click(launchOn(RUTH))

    // Assert
    expect(launchesSeen(host)).toEqual([{ command: 'server_launch', args: { domain: RUTH } }])
    const banner = await within(serverRow(RUTH)).findByRole('alert')
    expect(banner.textContent).toContain(golden.launchErrors[2].message)
    expect(banner.parentElement).toBe(serverRow(RUTH))
    expect(isBefore(banner, launchOn(RUTH))).toBe(true)
    expect(launchOn(RUTH).disabled).toBe(false)
  })

  it('should be disabled while the webview is offline, saying why', async () => {
    // Arrange
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      // Act
      renderLaunching({})
      await screen.findByRole('listitem', { name: RUTH })

      // Assert
      expect(launchOn(RUTH).disabled).toBe(true)
      const reason = within(serverRow(RUTH)).getByText(
        'Apps open from the web, so launching needs a connection.'
      )
      expect(descriptionOf(launchOn(RUTH))).toBe(reason.textContent)
      // Across the card, above its row of buttons, rather than in Apps' column.
      expect(reason.parentElement).toBe(serverRow(RUTH))
      expect(isBefore(reason, launchOn(RUTH))).toBe(true)
    } finally {
      onLine.mockRestore()
      // TanStack Query's online manager hears the window's events.
      act(() => {
        window.dispatchEvent(new Event('online'))
      })
    }
  })

  it.each([
    ['runningRenewalFailed', 'Running, checking it can be reached'],
    ['runningUnreachable', 'Running, not reachable yet: the relay answered 502'],
    [
      'runningTokenRejected',
      "The relay rejected this server's tunnel token. Enter a new token on the Relay tab of the server's page.",
    ],
    [
      'runningTunnelUnknown',
      'The relay has no tunnel for this server. The tunnel ruth may have been deleted. Check the tunnel name, or ask whoever runs the relay.',
    ],
  ] as const)(
    'should be disabled for a running server that is %s, described by its status note alone',
    async (statusName, note) => {
      // Arrange
      const events = fakeEvents()
      renderLaunching({ events })
      await screen.findByRole('listitem', { name: RUTH })

      // Act
      events.emit('server-status', golden.serverStatuses[statusName])

      // Assert
      await waitFor(() => {
        expect(launchOn(RUTH).disabled).toBe(true)
      })
      expect(descriptionOf(launchOn(RUTH))).toBe(note)
      expect(paragraphsOf(serverRow(RUTH))).toEqual([note])
    }
  )

  it('should be disabled for a running server with no valid certificate, saying why', async () => {
    // Arrange
    const events = fakeEvents()
    renderLaunching({ events })
    await screen.findByRole('listitem', { name: RUTH })

    // Act
    events.emit('server-status', {
      ...golden.serverStatuses.runningAndReachable,
      certificate: golden.serverStatuses.runningCacheFailed.certificate,
    })

    // Assert
    const reason = await within(serverRow(RUTH)).findByText(
      'The server has no valid certificate yet.'
    )
    expect(launchOn(RUTH).disabled).toBe(true)
    expect(descriptionOf(launchOn(RUTH))).toBe('The server has no valid certificate yet.')
    expect(isBefore(reason, launchOn(RUTH))).toBe(true)
  })

  it("should be disabled for a running server whose certificate browsers don't trust, saying why", async () => {
    // Arrange
    const events = fakeEvents()
    renderLaunching({ events })
    await screen.findByRole('listitem', { name: RUTH })

    // Act
    events.emit('server-status', golden.serverStatuses.runningAndReachableOnStaging)

    // Assert
    expect(
      await within(serverRow(RUTH)).findByText(
        "The server's certificate is from Let's Encrypt's staging CA, which browsers don't trust."
      )
    ).toBeDefined()
    expect(launchOn(RUTH).disabled).toBe(true)
  })

  it.each([
    ['starting', golden.serverStatuses.startingUnchecked, 'Starting'],
    [
      'stopped',
      golden.serverStatuses.stoppedWithAnError,
      "The server isn't running yet. It starts again on its own.",
    ],
  ] as const)(
    'should be disabled for a %s server whose policy wants it running, without changing the policy',
    async (_runState, status, description) => {
      // Arrange
      const { host } = renderLaunching({
        servers: listedWithLab({
          runPolicy: { kind: 'whileOpen' },
          status: { ...status, domain: LAB },
        }),
      })
      await screen.findByRole('listitem', { name: LAB })

      // Assert
      expect(within(serverRow(LAB)).getAllByText(description)).toHaveLength(1)
      expect(launchOn(LAB).disabled).toBe(true)
      expect(descriptionOf(launchOn(LAB))).toBe(description)
      expect(host.seen.map(({ command }) => command)).not.toContain('server_set_run_policy')
    }
  )

  it("should start an off server once confirmed, then launch it once it's launchable", async () => {
    // Arrange
    const user = userEvent.setup()
    const { host, events } = renderLaunching({
      answers: {
        server_set_run_policy: () => Promise.resolve({ kind: 'whileOpen' }),
        server_launch: () => Promise.resolve(null),
      },
    })
    await screen.findByRole('listitem', { name: LAB })

    // Act
    await user.click(launchOn(LAB))

    // Assert
    expect(within(openDialogOrThrow()).getByText('Start server and launch?')).toBeDefined()
    expect(host.seen.map(({ command }) => command)).not.toContain('server_set_run_policy')

    // Act
    await user.click(within(openDialogOrThrow()).getByRole('button', { name: 'Start and launch' }))

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_set_run_policy',
      args: { domain: LAB, choice: { kind: 'whileOpen' } },
    })
    expect(await within(serverRow(LAB)).findByRole('button', { name: 'Starting…' })).toBeDefined()
    expect(launchesSeen(host)).toEqual([])

    // Act
    events.emit('server-status', { ...golden.serverStatuses.runningRenewalFailed, domain: LAB })

    // Assert
    expect(within(serverRow(LAB)).getByRole('button', { name: 'Starting…' })).toBeDefined()
    expect(launchesSeen(host)).toEqual([])

    // Act
    events.emit('server-status', launchableStatus(LAB))
    events.emit('server-status', launchableStatus(LAB))

    // Assert
    await waitFor(() => {
      expect(within(serverRow(LAB)).queryByRole('button', { name: 'Starting…' })).toBeNull()
    })
    expect(launchesSeen(host)).toEqual([{ command: 'server_launch', args: { domain: LAB } }])
  })

  it('should ask to start a server whose until has ended, as for one that is off', async () => {
    // Arrange
    const user = userEvent.setup()
    renderLaunching({
      servers: listedWithLab({ runPolicy: { kind: 'until', at: '2026-10-06T17:42:00Z' } }),
    })
    await screen.findByRole('listitem', { name: LAB })

    // Act
    await user.click(launchOn(LAB))

    // Assert
    expect(within(openDialogOrThrow()).getByText('Start server and launch?')).toBeDefined()
  })

  it('should be disabled for a stopped server whose until has not ended, without changing the policy', async () => {
    // Arrange
    const { host } = renderLaunching({
      servers: listedWithLab({ runPolicy: { kind: 'until', at: '2099-01-01T00:00:00Z' } }),
    })
    await screen.findByRole('listitem', { name: LAB })

    // Assert
    expect(
      within(serverRow(LAB)).getByText("The server isn't running yet. It starts again on its own.")
    ).toBeDefined()
    expect(launchOn(LAB).disabled).toBe(true)
    expect(host.seen.map(({ command }) => command)).not.toContain('server_set_run_policy')
  })

  it('should change nothing when the question to start is cancelled', async () => {
    // Arrange
    const user = userEvent.setup()
    const { host } = renderLaunching({})
    await screen.findByRole('listitem', { name: LAB })
    await user.click(launchOn(LAB))

    // Act
    await user.click(within(openDialogOrThrow()).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(openDialog()).toBeNull()
    expect(launchOn(LAB).disabled).toBe(false)
    expect(host.seen.map(({ command }) => command)).not.toContain('server_set_run_policy')
    expect(launchesSeen(host)).toEqual([])
  })

  it("should show the host's refusal to start the server, and launch nothing", async () => {
    // Arrange
    const user = userEvent.setup()
    const { host } = renderLaunching({
      answers: {
        server_set_run_policy: () => Promise.reject(golden.launchErrors[4]),
        server_launch: () => Promise.resolve(null),
      },
    })
    await screen.findByRole('listitem', { name: LAB })
    await user.click(launchOn(LAB))

    // Act
    await user.click(within(openDialogOrThrow()).getByRole('button', { name: 'Start and launch' }))

    // Assert
    const banner = await within(serverRow(LAB)).findByRole('alert')
    expect(banner.textContent).toContain(golden.launchErrors[4].message)
    expect(openDialog()).toBeNull()
    expect(within(serverRow(LAB)).queryByRole('button', { name: 'Starting…' })).toBeNull()
    expect(launchesSeen(host)).toEqual([])

    // Act
    await user.click(launchOn(LAB))

    // Assert
    expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()
  })

  it('should leave a policy that became active while asking as it is, and wait for the start', async () => {
    // Arrange
    const user = userEvent.setup()
    const { host } = renderLaunching({
      answers: {
        server_set_run_policy: () => Promise.resolve({ kind: 'always' }),
        server_launch: () => Promise.resolve(null),
      },
    })
    await screen.findByRole('listitem', { name: LAB })
    await user.click(launchOn(LAB))
    await user.selectOptions(within(serverRow(LAB)).getByRole('combobox'), 'Always')
    await waitFor(() => {
      expect(host.seen.filter(({ command }) => command === 'server_set_run_policy')).toHaveLength(1)
    })

    // Act
    await user.click(within(openDialogOrThrow()).getByRole('button', { name: 'Start and launch' }))

    // Assert
    expect(await within(serverRow(LAB)).findByRole('button', { name: 'Starting…' })).toBeDefined()
    expect(host.seen.filter(({ command }) => command === 'server_set_run_policy')).toEqual([
      { command: 'server_set_run_policy', args: { domain: LAB, choice: { kind: 'always' } } },
    ])
  })

  it('should launch nothing once the wait for a started server is cancelled', async () => {
    // Arrange
    const user = userEvent.setup()
    const { host, events } = renderLaunching({
      answers: {
        server_set_run_policy: () => Promise.resolve({ kind: 'whileOpen' }),
        server_launch: () => Promise.resolve(null),
      },
    })
    await screen.findByRole('listitem', { name: LAB })
    await user.click(launchOn(LAB))
    await user.click(within(openDialogOrThrow()).getByRole('button', { name: 'Start and launch' }))

    // Act
    await user.click(await within(serverRow(LAB)).findByRole('button', { name: 'Cancel' }))
    events.emit('server-status', launchableStatus(LAB))

    // Assert
    await waitFor(() => {
      expect(launchOn(LAB).disabled).toBe(false)
    })
    expect(launchesSeen(host)).toEqual([])
  })

  /** Confirm Start and launch on the server `domain`'s card, and wait for Starting…. */
  const startAndLaunch = async (
    user: ReturnType<typeof userEvent.setup>,
    domain: string
  ): Promise<void> => {
    await screen.findByRole('listitem', { name: domain })
    await user.click(launchOn(domain))
    await user.click(within(openDialogOrThrow()).getByRole('button', { name: 'Start and launch' }))
    await within(serverRow(domain)).findByRole('button', { name: 'Starting…' })
  }

  /** Lab's status, as the golden `name` status of ruth's. */
  const labStatus = (
    name: keyof typeof golden.serverStatuses,
    changes: Readonly<Record<string, unknown>> = {}
  ): Readonly<Record<string, unknown>> => ({
    ...golden.serverStatuses[name],
    domain: LAB,
    ...changes,
  })

  it.each([
    ['starting', labStatus('startingUnchecked'), 'Starting'],
    [
      'running, not yet reached',
      labStatus('runningRenewalFailed'),
      'Running, checking it can be reached',
    ],
    [
      'running, unreachable, still getting a certificate',
      labStatus('runningUnreachable', {
        certificate: golden.serverStatuses.runningCacheFailed.certificate,
      }),
      'Running, not reachable yet: the relay answered 502',
    ],
    [
      'running, reachable, still getting a certificate',
      labStatus('runningAndReachable', {
        certificate: golden.serverStatuses.runningCacheFailed.certificate,
      }),
      'The server has no valid certificate yet.',
    ],
    [
      'stopped with the error it had before the start',
      labStatus('stoppedWithAnError'),
      "The server hasn't started yet.",
    ],
    [
      'stopped to start again',
      labStatus('stoppedAsItsPolicyEnded', {
        lastStop: { reason: 'stoppedForRestart', stoppedAt: '2026-10-06T18:00:00Z' },
      }),
      'It stopped to start again.',
    ],
  ] as const)(
    "should say once why a started server that is %s isn't launched yet, above Starting…",
    async (_state, status, reason) => {
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
      events.emit('server-status', status)

      // Assert
      const starting = await within(serverRow(LAB)).findByRole('button', { name: 'Starting…' })
      await waitFor(() => {
        expect(starting.getAttribute('aria-describedby')).not.toBeNull()
      })
      expect(descriptionOf(starting)).toBe(reason)
      expect(within(serverRow(LAB)).getAllByText(reason)).toHaveLength(1)
      expect(isBefore(within(serverRow(LAB)).getByText(reason), starting)).toBe(true)
      expect(within(serverRow(LAB)).getByRole('button', { name: 'Cancel' })).toBeDefined()
      expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()
      expect(launchesSeen(host)).toEqual([])
    }
  )

  it('should stop waiting, saying why above Launch, once its certificate order is failing', async () => {
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
    events.emit('server-status', labStatus('startingCaUnreachable'))

    // Assert
    const banner = await within(serverRow(LAB)).findByRole('alert')
    expect(banner.textContent).toContain("Ordering the server's certificate is failing.")
    expect(within(serverRow(LAB)).queryByRole('button', { name: 'Starting…' })).toBeNull()
    expect(isBefore(banner, launchOn(LAB))).toBe(true)
    events.emit('server-status', launchableStatus(LAB))
    await waitFor(() => {
      expect(launchOn(LAB).disabled).toBe(false)
    })
    expect(launchesSeen(host)).toEqual([])
  })

  it.each([
    [
      'its run stops with an error',
      labStatus('stoppedWithAnError', {
        lastStop: {
          reason: 'endedOnItsOwn',
          error: 'the address is in use',
          stoppedAt: '2026-10-06T18:00:00Z',
        },
      }),
      "The server isn't running yet. It starts again on its own.",
      'It stopped with an error: the address is in use',
    ],
    [
      "its certificate is one browsers don't trust",
      labStatus('runningAndReachableOnStaging'),
      "The server's certificate is from Let's Encrypt's staging CA, which browsers don't trust.",
      "The server's certificate is from Let's Encrypt's staging CA, which browsers don't trust.",
    ],
    [
      "the relay rejects its tunnel's token",
      labStatus('runningTokenRejected'),
      "The relay rejected this server's tunnel token. Enter a new token on the Relay tab of the server's page.",
      "The relay rejected this server's tunnel token. Enter a new token on the Relay tab of the server's page.",
    ],
    [
      'the relay has no tunnel of its name',
      labStatus('runningTunnelUnknown'),
      'The relay has no tunnel for this server. The tunnel lab may have been deleted. Check the tunnel name, or ask whoever runs the relay.',
      'The relay has no tunnel for this server. The tunnel lab may have been deleted. Check the tunnel name, or ask whoever runs the relay.',
    ],
  ] as const)(
    'should stop waiting without a failure of its own once %s, the card saying why once',
    async (_cause, status, description, cause) => {
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
      events.emit('server-status', status)

      // Assert
      await waitFor(() => {
        expect(within(serverRow(LAB)).queryByRole('button', { name: 'Starting…' })).toBeNull()
      })
      expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()
      expect(launchOn(LAB).disabled).toBe(true)
      expect(descriptionOf(launchOn(LAB))).toBe(description)
      expect(within(serverRow(LAB)).getAllByText(cause)).toHaveLength(1)
      events.emit('server-status', launchableStatus(LAB))
      await waitFor(() => {
        expect(launchOn(LAB).disabled).toBe(false)
      })
      expect(launchesSeen(host)).toEqual([])
    }
  )

  describe('while a started server is unreachable with a valid certificate', () => {
    const UNREACHABLE = 'Running, not reachable yet: the relay answered 502'

    const unreachableWithAValidCertificate = labStatus('runningUnreachable', {
      certificate: golden.serverStatuses.runningAndReachable.certificate,
    })

    /** What describes Starting… on lab's card. */
    const waitingReason = (): string | null | undefined =>
      descriptionOf(within(serverRow(LAB)).getByRole('button', { name: 'Starting…' }))

    /** Move the device's clock and timers on by `millis`. */
    const advance = (millis: number): void => {
      act(() => {
        vi.advanceTimersByTime(millis)
      })
    }

    /** Send lab's status as unreachable with a valid certificate, and wait for Starting… to say so. */
    const becomeUnreachable = async (events: FakeEvents): Promise<void> => {
      events.emit('server-status', unreachableWithAValidCertificate)
      await waitFor(() => {
        expect(waitingReason()).toBe(UNREACHABLE)
      })
    }

    /** Lab's card, waiting on a started lab, with fake timers from `NOW`. */
    const startWaiting = async (): Promise<{
      readonly host: FakeHost
      readonly events: FakeEvents
    }> => {
      vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(NOW) })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const launching = renderLaunching({
        answers: {
          server_set_run_policy: () => Promise.resolve({ kind: 'whileOpen' }),
          server_launch: () => Promise.resolve(null),
        },
      })
      await startAndLaunch(user, LAB)
      return launching
    }

    it('should keep waiting through a 502 shorter than the grace, then launch once reachable', async () => {
      // Arrange
      const { host, events } = await startWaiting()

      // Act
      await becomeUnreachable(events)
      advance(4_000)

      // Assert
      expect(waitingReason()).toBe(UNREACHABLE)
      expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()

      // Act
      events.emit('server-status', launchableStatus(LAB))

      // Assert
      await waitFor(() => {
        expect(launchesSeen(host)).toEqual([{ command: 'server_launch', args: { domain: LAB } }])
      })
      expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()
    })

    it('should stop waiting without a failure of its own once it has been unreachable for the grace', async () => {
      // Arrange
      const { host, events } = await startWaiting()
      await becomeUnreachable(events)

      // Act
      advance(5_000)

      // Assert
      await waitFor(() => {
        expect(within(serverRow(LAB)).queryByRole('button', { name: 'Starting…' })).toBeNull()
      })
      expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()
      expect(launchOn(LAB).disabled).toBe(true)
      expect(descriptionOf(launchOn(LAB))).toBe(UNREACHABLE)
      expect(within(serverRow(LAB)).getAllByText(UNREACHABLE)).toHaveLength(1)
      expect(launchesSeen(host)).toEqual([])
    })

    it.each([
      [
        'reachable',
        labStatus('runningAndReachable', {
          certificate: golden.serverStatuses.runningCacheFailed.certificate,
        }),
      ],
      ['not yet reached', labStatus('runningRenewalFailed')],
    ] as const)(
      'should start the grace again after a status that is %s',
      async (_state, between) => {
        // Arrange
        const { host, events } = await startWaiting()
        await becomeUnreachable(events)
        advance(4_000)

        // Act
        events.emit('server-status', between)
        await waitFor(() => {
          expect(waitingReason()).not.toBe(UNREACHABLE)
        })
        await becomeUnreachable(events)
        advance(4_000)

        // Assert
        expect(waitingReason()).toBe(UNREACHABLE)
        expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()

        // Act
        advance(1_000)

        // Assert
        await waitFor(() => {
          expect(within(serverRow(LAB)).queryByRole('button', { name: 'Starting…' })).toBeNull()
        })
        expect(within(serverRow(LAB)).queryByRole('alert')).toBeNull()
        expect(launchesSeen(host)).toEqual([])
      }
    )
  })

  it("should show the host's refusal of a started server's launch, and Launch again", async () => {
    // Arrange
    const user = userEvent.setup()
    const { host, events } = renderLaunching({
      answers: {
        server_set_run_policy: () => Promise.resolve({ kind: 'whileOpen' }),
        server_launch: () => Promise.reject(golden.launchErrors[3]),
      },
    })
    await startAndLaunch(user, LAB)

    // Act
    events.emit('server-status', launchableStatus(LAB))

    // Assert
    const banner = await within(serverRow(LAB)).findByRole('alert')
    expect(banner.textContent).toContain(golden.launchErrors[3].message)
    expect(launchesSeen(host)).toEqual([{ command: 'server_launch', args: { domain: LAB } }])
    expect(launchOn(LAB).disabled).toBe(false)

    // Act
    await user.click(launchOn(LAB))

    // Assert
    await waitFor(() => {
      expect(launchesSeen(host)).toHaveLength(2)
    })
  })
})

describe('Authorization', () => {
  const RUTH = 'ruth.relay.example.com'
  const LAB = 'lab.rathole.example.com'

  /** The list item of the server `domain`. */
  const serverRow = (domain: string): HTMLElement => screen.getByRole('listitem', { name: domain })

  /** The Authorization button on the server `domain`'s card. */
  const authorizationOn = (domain: string): HTMLButtonElement => {
    const button = within(serverRow(domain)).getByRole('button', { name: 'Authorization' })
    if (!(button instanceof HTMLButtonElement)) throw new Error('Authorization is no <button>')
    return button
  }

  /** Whether `first` comes before `second` in the document. */
  const isBefore = (first: Node, second: Node): boolean =>
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  /** The servers' list on a host answering `answers`, and the host. */
  const renderServers = (answers: Readonly<Record<string, () => Promise<unknown>>>): FakeHost => {
    const host = hostWith({ servers: () => Promise.resolve(golden.listedServers), answers })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })
    return host
  }

  it("should open a launchable server's Authorization app, and show the host's refusal", async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServers({
      server_open_authorization_app: () => Promise.reject(golden.launchErrors[2]),
    })
    await screen.findByRole('listitem', { name: RUTH })
    const launch = within(serverRow(RUTH)).getByRole('button', { name: 'Apps' })
    const edit = within(serverRow(RUTH)).getByRole('link', { name: 'Edit' })

    // Act
    await user.click(authorizationOn(RUTH))

    // Assert
    expect(isBefore(launch, authorizationOn(RUTH))).toBe(true)
    expect(isBefore(authorizationOn(RUTH), edit)).toBe(true)
    expect(host.seen.filter(({ command }) => command === 'server_open_authorization_app')).toEqual([
      { command: 'server_open_authorization_app', args: { domain: RUTH } },
    ])
    const banner = await within(serverRow(RUTH)).findByRole('alert')
    expect(banner.textContent).toContain(golden.launchErrors[2].message)
    expect(banner.parentElement).toBe(serverRow(RUTH))
    expect(isBefore(banner, launch)).toBe(true)
    expect(authorizationOn(RUTH).disabled).toBe(false)
  })

  it('should show one failure at a time across the card, cleared as Launch or Authorization starts', async () => {
    // Arrange
    const user = userEvent.setup()
    let launchAnswer = (): Promise<unknown> => Promise.reject(golden.launchErrors[3])
    renderServers({
      server_open_authorization_app: () => Promise.reject(golden.launchErrors[2]),
      server_launch: () => launchAnswer(),
    })
    await screen.findByRole('listitem', { name: RUTH })
    const launch = within(serverRow(RUTH)).getByRole('button', { name: 'Apps' })
    await user.click(authorizationOn(RUTH))
    await within(serverRow(RUTH)).findByRole('alert')

    // Act
    await user.click(launch)

    // Assert
    await waitFor(() => {
      expect(within(serverRow(RUTH)).getByRole('alert').textContent).toContain(
        golden.launchErrors[3].message
      )
    })
    expect(within(serverRow(RUTH)).getAllByRole('alert')).toHaveLength(1)

    // Act
    launchAnswer = () => Promise.resolve(null)
    await user.click(launch)

    // Assert
    await waitFor(() => {
      expect(within(serverRow(RUTH)).queryByRole('alert')).toBeNull()
    })
  })

  it('should be disabled for a server the host would refuse, described by its status', async () => {
    // Arrange
    renderServers({})
    await screen.findByRole('listitem', { name: LAB })

    // Assert
    expect(authorizationOn(LAB).disabled).toBe(true)
    const describedBy = authorizationOn(LAB).getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy ?? '')?.textContent).toBeTruthy()
  })

  it('should be disabled while the webview is offline', async () => {
    // Arrange
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      // Act
      renderServers({})
      await screen.findByRole('listitem', { name: RUTH })

      // Assert
      expect(authorizationOn(RUTH).disabled).toBe(true)
    } finally {
      onLine.mockRestore()
      // TanStack Query's online manager hears the window's events.
      act(() => {
        window.dispatchEvent(new Event('online'))
      })
    }
  })
})

describe('Add server', () => {
  const TOKEN = 'tunnel-token-123'
  const CLAIM_CODE = 'ABCD-EFGH'
  const TOKEN_INSTEAD = 'I have a tunnel name and full length token'
  const CLAIM_CODE_INSTEAD = 'I have a claim code'

  /** What `server_add` answers: the domain, or the host's refusal. */
  type AddAnswer = () => Promise<unknown>

  /**
   * Render Add server on a host whose `server_add` answers `add`, listing
   * no servers until one is added and the golden file's once one is, and
   * answering `server_set_run_policy` with `setRunPolicy`.
   */
  const renderAddServer = ({
    add = () => Promise.resolve('ruth.relay.example.com'),
    setRunPolicy = () => Promise.resolve({ kind: 'whileOpen' }),
  }: {
    readonly add?: AddAnswer
    readonly setRunPolicy?: () => Promise<unknown>
  } = {}): FakeHost => {
    let added = false
    const host = hostWith({
      servers: () => Promise.resolve(added ? golden.listedServers : []),
      answers: {
        server_add: () =>
          add().then((domain) => {
            added = true
            return domain
          }),
        server_set_run_policy: setRunPolicy,
      },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: '/servers/new',
    })
    return host
  }

  /** The step titled `title`, once it shows. */
  const stepTitled = async (title: string): Promise<HTMLElement> => {
    const heading = await screen.findByRole('heading', { name: title })
    const step = heading.closest('form, section')
    if (!(step instanceof HTMLElement)) throw new Error(`no ${title} step`)
    return step
  }

  /** The invokes of `command` the host saw. */
  const invokesOf = (host: FakeHost, command: string): readonly SeenInvoke[] =>
    host.seen.filter((invoke) => invoke.command === command)

  type User = ReturnType<typeof userEvent.setup>

  /** A custom relay's settings, as the relay step takes them; each one left out stays empty. */
  interface CustomRelay {
    readonly baseUrl?: string
    readonly rathole?: boolean
    readonly remoteAddr?: string
    readonly publicKey?: string
    readonly domain?: string
  }

  /**
   * Pick a different reverse proxy for a rathole `custom`, or else a
   * self-hosted Wildflower relay with Advanced open, on the relay step
   * `relay`, and enter `custom`.
   */
  const enterCustomRelay = async (
    user: User,
    relay: HTMLElement,
    custom: CustomRelay
  ): Promise<void> => {
    if (custom.rathole === true) {
      await user.click(within(relay).getByRole('radio', { name: 'A different reverse proxy' }))
    } else {
      await user.click(within(relay).getByRole('radio', { name: 'A self-hosted Wildflower relay' }))
      await user.click(within(relay).getByText('Advanced'))
    }
    const fields = [
      ['Wildflower Relay URL', custom.baseUrl],
      ['Server address', custom.remoteAddr],
      ['Public key', custom.publicKey],
      ['Tunnel domain', custom.domain],
    ] as const
    for (const [label, value] of fields) {
      // oxlint-disable-next-line no-await-in-loop -- a person fills one field after another
      if (value !== undefined) await user.type(within(relay).getByLabelText(label), value)
    }
  }

  /** Enter `custom`, or keep the Wildflower relay without it, then Continue. */
  const enterRelay = async (user: User, custom?: CustomRelay): Promise<void> => {
    const relay = await stepTitled('Relay')
    if (custom !== undefined) await enterCustomRelay(user, relay, custom)
    await user.click(within(relay).getByRole('button', { name: 'Continue' }))
  }

  /**
   * On the tunnel step, switch a Wildflower relay from its claim code to the
   * tunnel name and token; a rathole relay asks for them already.
   */
  const enterTokenInstead = async (user: User): Promise<HTMLElement> => {
    const tunnel = await stepTitled('Tunnel')
    const tokenInstead = within(tunnel).queryByRole('button', { name: TOKEN_INSTEAD })
    if (tokenInstead !== null) await user.click(tokenInstead)
    return tunnel
  }

  /** Enter the tunnel `ruth` and {@link TOKEN} on the tunnel step, then Add server. */
  const enterCredentials = async (user: User): Promise<void> => {
    const tunnel = await enterTokenInstead(user)
    await user.type(within(tunnel).getByLabelText('Tunnel name'), 'ruth')
    await user.type(within(tunnel).getByLabelText('Tunnel token'), TOKEN)
    await user.click(within(tunnel).getByRole('button', { name: 'Add server' }))
  }

  /** Enter `code` as the claim code on the tunnel step, then Add server. */
  const enterClaimCode = async (user: User, code: string): Promise<void> => {
    const tunnel = await stepTitled('Tunnel')
    await user.type(within(tunnel).getByLabelText('Claim code'), code)
    await user.click(within(tunnel).getByRole('button', { name: 'Add server' }))
  }

  it('should open from the empty list', async () => {
    // Arrange
    const user = userEvent.setup()
    renderBase({
      invoke: hostWith().invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })

    // Act
    await user.click(await screen.findByRole('link', { name: 'Add new server' }))

    // Assert
    const relay = await stepTitled('Relay')
    expect(within(relay).getByRole('radio', { name: 'Wildflower official relay' })).toHaveProperty(
      'checked',
      true
    )
    expect(within(relay).queryByLabelText('Wildflower Relay URL')).toBeNull()
  })

  it('should add a server on the Wildflower relay from a claim code, show its domain, and drop the code', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderAddServer()

    // Act
    await enterRelay(user)
    await enterClaimCode(user, CLAIM_CODE.toLowerCase())

    // Assert
    const done = await stepTitled('Server added')
    expect(within(done).getByText('ruth.relay.example.com')).toBeDefined()
    expect(within(done).getByText(/without being able to read it/)).toBeDefined()
    expect(invokesOf(host, 'server_add')).toEqual([
      {
        command: 'server_add',
        args: {
          relay: { kind: 'wildflowerOfficial' },
          credentials: { kind: 'claimCode', code: CLAIM_CODE },
        },
      },
    ])
    expect(screen.queryByDisplayValue(CLAIM_CODE)).toBeNull()
    expect(document.body.textContent).not.toContain(CLAIM_CODE)
  })

  it('should add a server on the Wildflower relay from a tunnel name and token, and drop the token', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderAddServer()

    // Act
    await enterRelay(user)
    const tunnel = await enterTokenInstead(user)
    expect(within(tunnel).getByLabelText('Tunnel token')).toHaveProperty('type', 'password')
    await enterCredentials(user)

    // Assert
    await stepTitled('Server added')
    expect(invokesOf(host, 'server_add')).toEqual([
      {
        command: 'server_add',
        args: {
          relay: { kind: 'wildflowerOfficial' },
          credentials: { kind: 'token', tunnelName: 'ruth', token: TOKEN },
        },
      },
    ])
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull()
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it.each([
    ['the Wildflower official relay', undefined],
    ['a self-hosted Wildflower relay', { baseUrl: 'https://relay.example.com' }],
  ] as const)(
    'should ask %s for a claim code, with the tunnel name and token a link away',
    async (_, custom) => {
      // Arrange
      const user = userEvent.setup()
      renderAddServer()
      await enterRelay(user, custom)
      const tunnel = await stepTitled('Tunnel')
      expect(
        within(tunnel).getByText("Enter the claim code from your relay's admin.")
      ).toBeDefined()
      expect(within(tunnel).queryByLabelText('Tunnel token')).toBeNull()
      const tokenInstead = within(tunnel).getByRole('button', { name: TOKEN_INSTEAD })
      const back = within(tunnel).getByRole('button', { name: 'Back' })
      expect(
        tokenInstead.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()

      // Act
      await user.click(tokenInstead)

      // Assert
      expect(within(tunnel).queryByLabelText('Claim code')).toBeNull()
      expect(within(tunnel).getByLabelText('Tunnel name')).toBeDefined()
      expect(within(tunnel).getByLabelText('Tunnel token')).toBeDefined()

      // Act
      await user.click(within(tunnel).getByRole('button', { name: CLAIM_CODE_INSTEAD }))

      // Assert
      expect(within(tunnel).getByLabelText('Claim code')).toBeDefined()
    }
  )

  it('should ask a rathole relay for the tunnel name and token alone', async () => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()

    // Act
    await enterRelay(user, {
      rathole: true,
      remoteAddr: 'relay.example.com:2333',
      publicKey: golden.enteredRelays.rathole.publicKey,
      domain: 'relay.example.com',
    })

    // Assert
    const tunnel = await stepTitled('Tunnel')
    expect(within(tunnel).getByLabelText('Tunnel name')).toBeDefined()
    expect(within(tunnel).queryByLabelText('Claim code')).toBeNull()
    expect(within(tunnel).queryByRole('button', { name: TOKEN_INSTEAD })).toBeNull()
    expect(within(tunnel).queryByRole('button', { name: CLAIM_CODE_INSTEAD })).toBeNull()
  })

  it('should not add a server with a blank claim code', async () => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()
    await enterRelay(user)
    const tunnel = await stepTitled('Tunnel')

    // Act
    await user.type(within(tunnel).getByLabelText('Claim code'), '   ')

    // Assert
    expect(within(tunnel).getByRole('button', { name: 'Add server' })).toHaveProperty(
      'disabled',
      true
    )
  })

  it.each([
    ['ABCD-EFG', 'one character short'],
    ['ABCDEFG', 'seven characters'],
    ['ABCD-EFGO', 'an O'],
    ['ABCD-EFG1', 'a 1'],
  ])('should not add a server with the claim code %j, %s', async (code) => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()
    await enterRelay(user)
    const tunnel = await stepTitled('Tunnel')

    // Act
    await user.type(within(tunnel).getByLabelText('Claim code'), code)

    // Assert
    expect(within(tunnel).getByRole('button', { name: 'Add server' })).toHaveProperty(
      'disabled',
      true
    )
  })

  it.each([['abcd-2345'], ['ABCD2345']])('should let the claim code %j be added', async (code) => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()
    await enterRelay(user)
    const tunnel = await stepTitled('Tunnel')

    // Act
    await user.type(within(tunnel).getByLabelText('Claim code'), code)

    // Assert
    expect(within(tunnel).getByRole('button', { name: 'Add server' })).toHaveProperty(
      'disabled',
      false
    )
  })

  it.each([
    [
      'a self-hosted Wildflower relay',
      { baseUrl: 'https://relay.example.com' },
      golden.enteredRelays.selfHostedWildflower,
    ],
    [
      'a pinned self-hosted Wildflower relay',
      {
        baseUrl: 'https://relay.example.com',
        remoteAddr: 'relay.example.com:2333',
        publicKey: golden.enteredRelays.selfHostedWildflowerPinned.pin.publicKey,
      },
      golden.enteredRelays.selfHostedWildflowerPinned,
    ],
    [
      'a rathole relay',
      {
        rathole: true,
        remoteAddr: 'relay.example.com:2333',
        publicKey: golden.enteredRelays.rathole.publicKey,
        domain: 'relay.example.com',
      },
      golden.enteredRelays.rathole,
    ],
  ] as const)('should send server_add %s as entered', async (_, custom, relay) => {
    // Arrange
    const user = userEvent.setup()
    const host = renderAddServer()

    // Act
    await enterRelay(user, custom)
    await enterCredentials(user)

    // Assert
    await stepTitled('Server added')
    expect(invokesOf(host, 'server_add').map((invoke) => invoke.args?.['relay'])).toEqual([relay])
  })

  it.each([
    [
      'a pinned self-hosted Wildflower relay',
      {
        baseUrl: 'https://relay.example.com',
        remoteAddr: 'relay.example.com:2333',
        publicKey: golden.enteredRelays.selfHostedWildflowerPinned.pin.publicKey,
      },
      ['https://relay.example.com', 'relay.example.com:2333'],
    ],
    [
      'a rathole relay',
      {
        rathole: true,
        remoteAddr: 'relay.example.com:2333',
        publicKey: golden.enteredRelays.rathole.publicKey,
        domain: 'relay.example.com',
      },
      ['relay.example.com:2333', 'relay.example.com'],
    ],
  ] as const)(
    'should redact the hosts typed for %s from telemetry before server_add',
    async (_, custom, hosts) => {
      // Arrange
      const user = userEvent.setup()
      const host = renderAddServer()
      await enterRelay(user, custom)
      redactServerHostMock.mockClear()
      let redactedBeforeAdd: readonly unknown[] = []
      redactServerHostMock.mockImplementation(() => {
        if (invokesOf(host, 'server_add').length === 0) {
          redactedBeforeAdd = redactServerHostMock.mock.calls.map(([redacted]) => redacted)
        }
      })

      // Act
      await enterCredentials(user)

      // Assert
      await stepTitled('Server added')
      expect(redactedBeforeAdd).toStrictEqual(hosts)
    }
  )

  it("should redact the added server's domain from telemetry once the host answers with it", async () => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer({ add: () => Promise.resolve('ruth.self-hosted.example') })
    await enterRelay(user, {
      baseUrl: 'https://relay.example.com',
      remoteAddr: 'relay.example.com:2333',
      publicKey: golden.enteredRelays.selfHostedWildflowerPinned.pin.publicKey,
    })

    // Act
    await enterCredentials(user)

    // Assert
    await stepTitled('Server added')
    expect(redactServerHostMock).toHaveBeenCalledWith('ruth.self-hosted.example')
  })

  it('should lowercase the tunnel name and relay domain as they are typed', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderAddServer()

    // Act
    await enterRelay(user, {
      rathole: true,
      remoteAddr: 'relay.example.com:2333',
      publicKey: golden.enteredRelays.rathole.publicKey,
      domain: 'Relay.Example.COM',
    })
    const tunnel = await stepTitled('Tunnel')
    await user.type(within(tunnel).getByLabelText('Tunnel name'), 'Ruth')
    await user.type(within(tunnel).getByLabelText('Tunnel token'), TOKEN)
    await user.click(within(tunnel).getByRole('button', { name: 'Add server' }))

    // Assert
    await stepTitled('Server added')
    const [added] = invokesOf(host, 'server_add')
    expect(added?.args?.['relay']).toEqual(golden.enteredRelays.rathole)
    expect(added?.args?.['credentials']).toEqual({
      kind: 'token',
      tunnelName: 'ruth',
      token: TOKEN,
    })
  })

  it.each([
    ['the Wildflower official relay', undefined, 'ruth.relay.wildflowerhealth.io'],
    [
      'a self-hosted Wildflower relay',
      { baseUrl: 'https://relay.example.com' },
      "ruth.[your relay's domain]",
    ],
    [
      'a rathole relay',
      { rathole: true, remoteAddr: 'r:2333', publicKey: 'k', domain: 'tunnels.example.com' },
      'ruth.tunnels.example.com',
    ],
  ] as const)('should say where the server will be for %s', async (_, custom, address) => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()
    await enterRelay(user, custom)
    const tunnel = await enterTokenInstead(user)
    expect(
      within(tunnel).getByText(/^Your server will be available at \[tunnel name\]\./)
    ).toBeDefined()

    // Act
    await user.type(within(tunnel).getByLabelText('Tunnel name'), 'ruth')

    // Assert
    expect(within(tunnel).getByText(`Your server will be available at ${address}`)).toBeDefined()
    expect(within(tunnel).getByText(/public Certificate Transparency logs/)).toBeDefined()
  })

  it('should link the relay step to what a relay can see', async () => {
    // Arrange
    renderAddServer()

    // Act
    const relay = await stepTitled('Relay')

    // Assert
    expect(
      within(relay).getByRole('link', { name: "What a relay can and can't see" })
    ).toHaveProperty(
      'href',
      'https://github.com/wildflowerhealthio/Wildflower/blob/main/docs/Relay/Explanation.md'
    )
  })

  it('should say a rathole relay is tested when the server starts', async () => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()
    const relay = await stepTitled('Relay')

    // Act
    await enterCustomRelay(user, relay, { rathole: true })

    // Assert
    expect(within(relay).getByText(/will be tested when the server starts/)).toBeDefined()
    expect(within(relay).getByRole('link', { name: 'rathole' })).toHaveProperty(
      'href',
      'https://github.com/rathole-org/rathole'
    )
    expect(within(relay).queryByLabelText('Wildflower Relay URL')).toBeNull()
  })

  it.each([
    ['no base URL', {}],
    ['a pin without its key', { baseUrl: 'https://relay.example.com', remoteAddr: 'r:2333' }],
    ['a rathole relay without its domain', { rathole: true, remoteAddr: 'r:2333', publicKey: 'k' }],
  ] as const)('should not continue from a custom relay with %s', async (_, custom) => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()
    const relay = await stepTitled('Relay')

    // Act
    await enterCustomRelay(user, relay, custom)

    // Assert
    expect(within(relay).getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  })

  it('should not add a server with a blank token', async () => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer()
    await enterRelay(user)
    const tunnel = await enterTokenInstead(user)
    const add = within(tunnel).getByRole('button', { name: 'Add server' })

    // Act
    await user.type(within(tunnel).getByLabelText('Tunnel name'), 'ruth')
    await user.type(within(tunnel).getByLabelText('Tunnel token'), '   ')

    // Assert
    expect(add).toHaveProperty('disabled', true)
  })

  it('should show Checking while the host checks with the relay', async () => {
    // Arrange
    const user = userEvent.setup()
    let answer: (domain: string) => void = () => undefined
    renderAddServer({
      add: () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    })
    await enterRelay(user)

    // Act
    await enterCredentials(user)

    // Assert
    const checking = await stepTitled('Checking')
    expect(within(checking).getByRole('status').textContent).toContain('Checking with the relay')

    // Act
    answer('ruth.relay.example.com')

    // Assert
    expect(await stepTitled('Server added')).toBeDefined()
  })

  it.each(
    Object.values(golden.enrolmentErrors).filter((error) => error.kind !== 'relayIdentityChanged')
  )("should stay on Checking with the host's $kind refusal", async (refusal) => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer({ add: () => Promise.reject(refusal) })
    await enterRelay(user)

    // Act
    await enterCredentials(user)

    // Assert
    const checking = await stepTitled('Checking')
    expect(within(checking).getByRole('alert').textContent).toContain(refusal.message)
    expect(within(checking).getByRole('button', { name: 'Back' })).toBeDefined()
    expect(within(checking).getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('should go Back from a refusal with every entry kept', async () => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer({ add: () => Promise.reject(golden.enrolmentErrors.relayUnreachable) })
    await enterRelay(user, { baseUrl: 'https://relay.example.com' })
    await enterCredentials(user)

    // Act
    await user.click(within(await stepTitled('Checking')).getByRole('button', { name: 'Back' }))

    // Assert
    const tunnel = await stepTitled('Tunnel')
    expect(within(tunnel).getByLabelText('Tunnel name')).toHaveProperty('value', 'ruth')
    expect(within(tunnel).getByLabelText('Tunnel token')).toHaveProperty('value', TOKEN)

    // Act
    await user.click(within(tunnel).getByRole('button', { name: 'Back' }))

    // Assert
    const relay = await stepTitled('Relay')
    expect(
      within(relay).getByRole('radio', { name: 'A self-hosted Wildflower relay' })
    ).toHaveProperty('checked', true)
    expect(within(relay).getByLabelText('Wildflower Relay URL')).toHaveProperty(
      'value',
      'https://relay.example.com'
    )
  })

  it('should send server_add again on Retry, and reach the server added', async () => {
    // Arrange
    const user = userEvent.setup()
    let add: AddAnswer = () => Promise.reject(golden.enrolmentErrors.relayUnreachable)
    const host = renderAddServer({ add: () => add() })
    await enterRelay(user)
    await enterCredentials(user)
    const checking = await stepTitled('Checking')
    await within(checking).findByRole('alert')

    // Act
    add = () => Promise.resolve('ruth.relay.example.com')
    await user.click(within(checking).getByRole('button', { name: 'Retry' }))

    // Assert
    expect(await stepTitled('Server added')).toBeDefined()
    expect(invokesOf(host, 'server_add')).toHaveLength(2)
  })

  it.each([
    ['Start now', { kind: 'whileOpen' }],
    ['Start later', { kind: 'off' }],
  ] as const)('should set the run policy on %s, then open the server', async (label, choice) => {
    // Arrange
    const user = userEvent.setup()
    const host = renderAddServer({ setRunPolicy: () => Promise.resolve(choice) })
    await enterRelay(user)
    await enterCredentials(user)

    // Act
    await user.click(within(await stepTitled('Server added')).getByRole('button', { name: label }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Server' })).toBeDefined()
    expect(invokesOf(host, 'server_set_run_policy')).toEqual([
      { command: 'server_set_run_policy', args: { domain: 'ruth.relay.example.com', choice } },
    ])
  })

  it("should stay on the server added with the host's refusal to start it", async () => {
    // Arrange
    const user = userEvent.setup()
    renderAddServer({ setRunPolicy: () => Promise.reject(golden.commandErrors[2]) })
    await enterRelay(user)
    await enterCredentials(user)
    const done = await stepTitled('Server added')

    // Act
    await user.click(within(done).getByRole('button', { name: 'Start now' }))

    // Assert
    expect((await within(done).findByRole('alert')).textContent).toContain(
      golden.commandErrors[2].message
    )
    expect(within(done).getByRole('button', { name: 'Start now' })).toHaveProperty(
      'disabled',
      false
    )
  })
})

describe('Host Settings', () => {
  /** The row of the list titled `section` whose title is `title`. */
  const rowIn = (section: string, title: string): HTMLElement => {
    const list = screen.getByRole('heading', { name: section }).closest('section')
    if (list === null) throw new Error(`no ${section} list`)
    const row = within(list).getByText(title).closest('li')
    if (row === null) throw new Error(`no ${title} row`)
    return row
  }

  it.each([
    [true, "Allowed — you'll get a notification if a server stops or is paused."],
    [
      false,
      'Blocked — to hear when a server stops, allow notifications for Wildflower in your system settings.',
    ],
    [null, 'Not asked yet — select to allow notifications when a server stops.'],
  ] as const)(
    'should read a notification permission of %j as "%s"',
    async (permission, expectedSubtitle) => {
      // Arrange
      const host = hostWith({ permission })

      // Act
      renderBase({
        invoke: host.invoke,
        storage: storageAnswered({ crashReports: false, performance: false }),
        path: '/settings',
      })

      // Assert
      expect(await screen.findByText(expectedSubtitle)).toBeDefined()
    }
  )

  it('should ask for notifications when the OS has yet to, and show the answer', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = fakeHost({
      ...steadyAnswers,
      'plugin:notification|is_permission_granted': () => Promise.resolve(null),
      'plugin:notification|request_permission': () => Promise.resolve('granted'),
      'plugin:app|version': () => Promise.resolve('0.4.0'),
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: '/settings',
    })

    // Act
    await user.click(await screen.findByRole('button', { name: /Not asked yet/ }))

    // Assert
    expect(
      await screen.findByText("Allowed — you'll get a notification if a server stops or is paused.")
    ).toBeDefined()
    expect(host.seen.map(({ command }) => command)).toContain(
      'plugin:notification|request_permission'
    )
  })

  it('should say so when the permission cannot be read', async () => {
    // Arrange
    const host = fakeHost({
      ...steadyAnswers,
      'plugin:notification|is_permission_granted': () => Promise.reject('plugin missing'),
      'plugin:app|version': () => Promise.resolve('0.4.0'),
    })

    // Act
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: '/settings',
    })

    // Assert
    expect(
      await screen.findByText("Couldn't check whether notifications are allowed.")
    ).toBeDefined()
  })

  it('should read the stored telemetry answer and reopen the dialog from its row', async () => {
    // Arrange
    const user = userEvent.setup()
    renderBase({
      invoke: hostWith().invoke,
      storage: storageAnswered({ crashReports: true, performance: false }),
      path: '/settings',
    })
    const { crashReports, performance } = WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY

    // Assert
    expect(
      await screen.findByText(`${crashReports.label} on · ${performance.label} off`)
    ).toBeDefined()
    expect(openDialog()).toBeNull()

    // Act
    await user.click(screen.getByRole('button', { name: /^Telemetry/ }))

    // Assert
    expect(openDialog()).not.toBeNull()
  })

  it('should show the version the host answers in About', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/), async (version) => {
        // Arrange
        const host = hostWith({ version })

        // Act
        renderBase({
          invoke: host.invoke,
          storage: storageAnswered({ crashReports: false, performance: false }),
          path: '/settings',
        })

        // Assert
        await waitFor(() => {
          expect(rowIn('About', 'Version').textContent).toContain(version)
        })
        cleanup()
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })
})
