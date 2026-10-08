import { createMemoryHistory } from '@tanstack/react-router'
import {
  act,
  cleanup,
  render,
  type RenderResult,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from 'branding-core'
import type { Context } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { TauriInvoke } from 'servers-core'
import { type ConsentStorage, type TelemetryConsent, writeConsent } from 'telemetry-core'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import { BaseRoot } from './base-root.tsx'
import type { ListenToHostEvent } from './router-context.ts'

// Starting the SDK is the collaborator whose every touch the gate controls, so
// the module boundary is where it is stubbed; the rest stays real.
const { initConsentedTelemetryMock } = vi.hoisted(() => ({
  initConsentedTelemetryMock: vi.fn<typeof TelemetryWeb.initConsentedTelemetry>(() => false),
}))
vi.mock('telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: initConsentedTelemetryMock,
}))

const BASE_DSN = 'https://key@sentry.example/12'

/** A `ConsentStorage` kept in a `Map`, standing in for the webview's `localStorage`. */
const mapConsentStorage = (): ConsentStorage => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

/** A storage holding a current answer, as a returning user's has. */
const storageAnswered = (
  switches: Pick<TelemetryConsent, 'crashReports' | 'performance'>
): ConsentStorage => {
  const storage = mapConsentStorage()
  writeConsent(storage, {
    version: WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY.version,
    decidedAt: '2026-10-06T12:00:00.000Z',
    ...switches,
  })
  return storage
}

/** One invoke the fake host saw. */
interface SeenInvoke {
  readonly command: string
  readonly args: Readonly<Record<string, unknown>> | undefined
}

/** A fake host and the invokes it saw. */
interface FakeHost {
  readonly invoke: Context.Tag.Service<TauriInvoke>
  readonly seen: SeenInvoke[]
}

/**
 * A host answering each command from `answers`, rejecting any other, and
 * recording every invoke.
 */
const fakeHost = (answers: Readonly<Record<string, () => Promise<unknown>>>): FakeHost => {
  const seen: SeenInvoke[] = []
  return {
    seen,
    invoke: (command, args) => {
      seen.push({ command, args })
      const answer = answers[command]
      return answer === undefined
        ? Promise.reject(new Error(`unexpected command ${command}`))
        : answer()
    },
  }
}

/** The answers every host gives that a test doesn't change. */
const steadyAnswers = {
  'plugin:background-service|configure_recovery': () => Promise.resolve(null),
} as const

/**
 * A host whose notification permission reads `permission`, whose version is
 * `version`, and whose `servers_list` answers `servers`.
 */
const hostWith = ({
  permission = true,
  version = '0.4.0',
  servers = () => Promise.resolve([]),
  answers = {},
}: {
  readonly permission?: boolean | null
  readonly version?: string
  readonly servers?: () => Promise<unknown>
  readonly answers?: Readonly<Record<string, () => Promise<unknown>>>
} = {}): FakeHost =>
  fakeHost({
    ...steadyAnswers,
    'plugin:notification|is_permission_granted': () => Promise.resolve(permission),
    'plugin:app|version': () => Promise.resolve(version),
    servers_list: servers,
    ...answers,
  })

/** Host events a test emits, and the listeners the base has up. */
interface FakeEvents {
  readonly listen: ListenToHostEvent
  /** Deliver `payload` to every listener of `event`. */
  readonly emit: (event: string, payload: unknown) => void
}

const fakeEvents = (): FakeEvents => {
  const listeners = new Set<{
    readonly event: string
    readonly handler: (event: { readonly payload: unknown }) => void
  }>()
  return {
    listen: (event, handler) => {
      const listener = { event, handler }
      listeners.add(listener)
      return Promise.resolve(() => {
        listeners.delete(listener)
      })
    },
    emit: (event, payload) => {
      for (const listener of listeners) {
        if (listener.event === event) listener.handler({ payload })
      }
    },
  }
}

const BACKGROUND_SERVICE_START_CONFIG = {
  serviceLabel: 'Wildflower server is running',
  foregroundServiceType: 'specialUse',
} as const

const renderBase = ({
  invoke,
  storage,
  path = '/',
  events = fakeEvents(),
}: {
  readonly invoke: Context.Tag.Service<TauriInvoke>
  readonly storage: ConsentStorage
  readonly path?: string
  readonly events?: FakeEvents
}): RenderResult =>
  render(
    <BaseRoot
      invoke={invoke}
      listen={events.listen}
      backgroundServiceStartConfig={BACKGROUND_SERVICE_START_CONFIG}
      telemetry={{ dsn: BASE_DSN, app: 'wildflower-tauri' }}
      history={createMemoryHistory({ initialEntries: [path] })}
      storage={storage}
    />
  )

/**
 * jsdom has no native `<dialog>`: `showModal` and `close` are modelled as the
 * `open` attribute, and the original descriptors are put back after each test.
 */
const dialogMethodDescriptors = (['showModal', 'close'] as const).map(
  (method) =>
    [method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)] as const
)

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  initConsentedTelemetryMock.mockClear()
  for (const [method, descriptor] of dialogMethodDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
  }
})

/** The consent `<dialog>` while it is open, or `null`. */
const openDialog = (): HTMLDialogElement | null => document.querySelector('dialog[open]')

describe('BaseRoot', () => {
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
    expect(tags).toStrictEqual({ app: 'wildflower-tauri' })
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
    expect(config.otel.serviceName).toBe('wildflower-tauri')
    expect(tags).toStrictEqual({ app: 'wildflower-tauri' })
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

  const renderListed = (servers: readonly unknown[], events = fakeEvents()): FakeHost => {
    const host = hostWith({ servers: () => Promise.resolve(servers) })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      events,
    })
    return host
  }

  it('should say what a server is, and offer Add server, when there are none', async () => {
    // Act
    renderListed([])

    // Assert
    expect(await screen.findByText('No servers yet')).toBeDefined()
    expect(screen.getByText(/^A server keeps your health records on this device/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Add server' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it.each([
    ['one server', [golden.listedServers[0]]],
    ['several servers', golden.listedServers],
  ] as const)('should show a card for each of %s', async (_, servers) => {
    // Act
    renderListed(servers)

    // Assert
    await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(screen.getAllByRole('listitem').map((card) => card.getAttribute('aria-label'))).toEqual(
      servers.map((server) => server.domain)
    )
    for (const card of screen.getAllByRole('listitem')) {
      expect(within(card).getByRole('button', { name: 'Launch' })).toHaveProperty('disabled', true)
    }
  })

  it.each([
    ['runningAndReachable', 'Success: Running'],
    ['startingUnchecked', 'Starting'],
    ['runningUnreachable', 'Warning: Running, not reachable yet'],
    ['neverRun', 'Stopped'],
    ['stoppedWithAnError', 'Error: Stopped'],
  ] as const)('should merge a %s status into the badge "%s"', async (statusName, badge) => {
    // Act
    renderListed([
      { ...golden.listedServers[0], status: golden.serverStatuses[statusName] },
      golden.listedServers[1],
    ])

    // Assert
    const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(
      within(ruth)
        .getAllByRole('status')
        .map((status) => status.textContent)
    ).toContain(badge)
  })

  it.each([
    [{ kind: 'off' }, /^Off$/],
    [{ kind: 'whileOpen' }, /^On while Wildflower is open$/],
    [{ kind: 'until', at: '2999-01-01T00:00:00Z' }, /^On until \S/],
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

  it('should show a running server as running', async () => {
    // Act
    renderListed(golden.listedServers)

    // Assert
    const ruth = await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(within(ruth).getByText('Running')).toBeDefined()
  })

  it("should show a stopped server's error", async () => {
    // Act
    renderListed(golden.listedServers)

    // Assert
    const lab = await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })
    expect(within(lab).getByText('Stopped')).toBeDefined()
    expect(
      within(lab).getByText("It stopped with an error: the server's config couldn't be built")
    ).toBeDefined()
    expect(runPolicyOf('lab.rathole.example.com').shown).toBe('Off')
  })

  it('should show an until that has passed as ended, and one ahead as until', async () => {
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
    expect(runPolicyOf('ruth.relay.example.com').shown).toMatch(/^Until /)
  })

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
    expect(within(ruth).queryByText('Running')).toBeNull()
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
    expect(within(ruth).queryByText('Running')).toBeNull()
  })

  it('should offer the run-policy presets', async () => {
    // Act
    renderListed(golden.listedServers)

    // Assert
    await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })
    expect(
      Array.from(runPolicyOf('lab.rathole.example.com').control.options, (option) => option.text)
    ).toEqual(['Off', 'While open', 'For 15 minutes', 'For 1 hour', 'For 8 hours', 'Always'])
  })

  it.each([
    ['Off', { kind: 'off' }],
    ['While open', { kind: 'whileOpen' }],
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

  it('should remove a server only once the user confirms', async () => {
    // Arrange
    const user = userEvent.setup()
    let listed: readonly unknown[] = golden.listedServers
    const host = hostWith({
      servers: () => Promise.resolve(listed),
      answers: {
        server_remove: () => {
          listed = [golden.listedServers[0]]
          return Promise.resolve(null)
        },
      },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })
    const lab = await screen.findByRole('listitem', { name: 'lab.rathole.example.com' })

    // Act
    await user.click(within(lab).getByRole('button', { name: 'Remove' }))
    await user.click(within(lab).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(host.seen.map(({ command }) => command)).not.toContain('server_remove')

    // Act
    await user.click(within(lab).getByRole('button', { name: 'Remove' }))
    const dialog = openDialog()
    if (dialog === null) throw new Error('no confirm dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_remove',
      args: { domain: 'lab.rathole.example.com' },
    })
    await waitFor(() => {
      expect(screen.queryByRole('listitem', { name: 'lab.rathole.example.com' })).toBeNull()
    })
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
