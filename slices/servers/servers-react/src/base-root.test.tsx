import { HttpClient, HttpClientError, HttpClientResponse } from '@effect/platform'
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
import { type Context, DateTime, Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { TauriInvoke } from 'servers-core'
import { type ConsentStorage, type TelemetryConsent, writeConsent } from 'telemetry-core'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import { BaseRoot, type BaseRootProps } from './base-root.tsx'
import { formatInstant } from './server-status-text.ts'

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
  pending_consents_list: () => Promise.resolve([]),
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
  readonly listen: BaseRootProps['listen']
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

/** A stub HTTP client answering the base's `/health` reads, and the URLs it was asked for. */
interface FakeHealth {
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  readonly urls: readonly string[]
}

/**
 * A client answering every request with `answer`'s response; an `answer`
 * that throws is a request that never reached a server, failing as
 * `FetchHttpClient` fails one.
 */
const fakeHealth = (answer: () => Response): FakeHealth => {
  const urls: string[] = []
  return {
    urls,
    layer: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        urls.push(request.url)
        return Effect.try({
          try: () => HttpClientResponse.fromWeb(request, answer()),
          catch: (cause) =>
            new HttpClientError.RequestError({ request, reason: 'Transport', cause }),
        })
      })
    ),
  }
}

const BACKGROUND_SERVICE_START_CONFIG = {
  serviceLabel: 'Wildflower server is running',
  foregroundServiceType: 'specialUse',
} as const

/**
 * The launcher the app passes as the host's default: the golden file's first
 * server has it, its second doesn't.
 */
const DEFAULT_LAUNCHER_URL = 'https://wildflowerhealth.io/app'

const renderBase = ({
  invoke,
  storage,
  path = '/',
  events = fakeEvents(),
  httpClient = fakeHealth(() => Response.json({ status: 'pass' })).layer,
}: {
  readonly invoke: Context.Tag.Service<TauriInvoke>
  readonly storage: ConsentStorage
  readonly path?: string
  readonly events?: FakeEvents
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>
}): RenderResult =>
  render(
    <BaseRoot
      invoke={invoke}
      listen={events.listen}
      backgroundServiceStartConfig={BACKGROUND_SERVICE_START_CONFIG}
      defaultLauncherUrl={DEFAULT_LAUNCHER_URL}
      telemetry={{ dsn: BASE_DSN, app: 'wildflower-tauri' }}
      httpClient={httpClient}
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
  ] as const)('should show a card, with Launch and Edit, for each of %s', async (_, servers) => {
    // Act
    renderListed(servers)

    // Assert
    await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })
    expect(screen.getAllByRole('listitem').map((card) => card.getAttribute('aria-label'))).toEqual(
      servers.map((server) => server.domain)
    )
    for (const card of screen.getAllByRole('listitem')) {
      expect(within(card).getByRole('button', { name: 'Launch' })).toHaveProperty('disabled', false)
      expect(within(card).getByRole('link', { name: 'Edit' })).toBeDefined()
    }
  })

  it.each([
    ['runningAndReachable', 'Running', 'success'],
    ['startingUnchecked', 'Starting', 'info'],
    ['runningUnreachable', 'Running, not reachable yet', 'warning'],
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
    expect(runPolicyOf('ruth.relay.example.com').shown).toMatch(/^On until /)
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
      expect(runPolicyOf('lab.rathole.example.com').shown).toMatch(/^On until /)
    })
    expect(
      within(serverRow('lab.rathole.example.com')).getByText(/^On until \S/, { selector: 'span' })
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

describe('the server page', () => {
  /** A `/health` check object as a server serves it. */
  const healthCheck = (status: string): Readonly<Record<string, string>> => ({
    componentType: 'system',
    status,
    time: '2026-10-06T17:01:00Z',
  })

  /** A passing `/health` report, with a check for each of the server's components. */
  const passingReport = {
    status: 'pass',
    checks: {
      server: [healthCheck('pass')],
      connectivity: [healthCheck('pass')],
      'fhir-r4': [healthCheck('pass')],
    },
  }

  /**
   * `golden.listedServers` with ruth's status set to `status`, and its
   * certificate to the status's, as `servers_list` lists it.
   */
  const listedWithRuthStatus = (status: { readonly certificate: unknown }): readonly unknown[] => [
    { ...golden.listedServers[0], status, certificate: status.certificate },
    golden.listedServers[1],
  ]

  /**
   * Render the page of the server `domain` on a host listing `servers`, with
   * `/health` answered by `health`.
   */
  const renderServerPage = ({
    domain,
    servers = golden.listedServers,
    answers = {},
    health = fakeHealth(() => Response.json(passingReport)),
    events = fakeEvents(),
  }: {
    readonly domain: string
    readonly servers?: readonly unknown[]
    readonly answers?: Readonly<Record<string, () => Promise<unknown>>>
    readonly health?: FakeHealth
    readonly events?: FakeEvents
  }): FakeHost => {
    const host = hostWith({ servers: () => Promise.resolve(servers), answers })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: `/servers/${domain}`,
      events,
      httpClient: health.layer,
    })
    return host
  }

  /** The page's status hero. */
  const hero = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Status' })

  /** The section of the list or form titled `title`. */
  const sectionTitled = (title: string): HTMLElement => {
    const section = screen.getByRole('heading', { name: title }).closest('section')
    if (section === null) throw new Error(`no ${title} section`)
    return section
  }

  /** The open confirm dialog. */
  const confirmDialog = (): HTMLDialogElement => {
    const dialog = openDialog()
    if (dialog === null) throw new Error('no confirm dialog')
    return dialog
  }

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
    expect(
      screen.getByText('Self-hosted Wildflower relay at https://relay.example.com/')
    ).toBeDefined()
    expect(screen.getByText('ruth')).toBeDefined()
    expect(screen.getByLabelText('Launcher')).toHaveProperty(
      'value',
      'https://wildflowerhealth.io/app'
    )
    expect(screen.getByText("Let's Encrypt")).toBeDefined()

    // Act
    await user.click(screen.getByRole('link', { name: 'Servers' }))

    // Assert
    expect(await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })).toBeDefined()
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
      const status = within(await hero()).getByRole('status')
      expect(status.textContent).toMatch(new RegExp(`${label}$`))
      expect(within(await hero()).queryByText(/^Since /) !== null).toBe(running)
      expect(within(await hero()).getByRole('combobox', { name: /runs$/ })).toBeDefined()
    }
  )

  it('should copy the domain, and say so when the clipboard refuses', async () => {
    // Arrange
    const user = userEvent.setup()
    renderServerPage({ domain: 'ruth.relay.example.com' })
    const copy = within(await hero()).getByRole('button', { name: 'Copy' })

    // Act
    await user.click(copy)

    // Assert
    expect(await navigator.clipboard.readText()).toBe('ruth.relay.example.com')
    expect(within(await hero()).getByRole('button', { name: 'Copied' })).toBeDefined()

    // Act
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('not allowed'))
    await user.click(within(await hero()).getByRole('button', { name: 'Copied' }))

    // Assert
    expect(
      await screen.findByText('The clipboard refused. Select the domain to copy it by hand.')
    ).toBeDefined()
  })

  it("should list each check of a passing /health, read from the server's public origin", async () => {
    // Arrange
    const health = fakeHealth(() => Response.json(passingReport))

    // Act
    renderServerPage({ domain: 'ruth.relay.example.com', health })

    // Assert
    expect(await screen.findByText('Its /health answers pass.')).toBeDefined()
    const checks = sectionTitled('Health checks')
    for (const key of ['server', 'connectivity', 'fhir-r4']) {
      expect(within(checks).getByText(key)).toBeDefined()
    }
    expect(health.urls).toEqual(['https://ruth.relay.example.com/health'])
  })

  it('should list the checks of a failing /health from its 503', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      health: fakeHealth(() =>
        Response.json(
          {
            status: 'fail',
            checks: { server: [healthCheck('pass')], connectivity: [healthCheck('fail')] },
          },
          { status: 503 }
        )
      ),
    })

    // Assert
    expect(await screen.findByText('Its /health answers fail.')).toBeDefined()
    const connectivity = within(sectionTitled('Health checks')).getByText('connectivity')
    expect(connectivity.closest('li')?.textContent).toContain('fail')
  })

  it.each([
    ['a 404', () => new Response('not found', { status: 404 }), /^Couldn't read it: .*404/],
    [
      'a network error',
      () => {
        throw new TypeError('Failed to fetch')
      },
      /^Couldn't read it: Transport error/,
    ],
  ] as const)('should say why /health could not be read after %s', async (_, answer, shown) => {
    // Act
    renderServerPage({ domain: 'ruth.relay.example.com', health: fakeHealth(answer) })

    // Assert
    expect(await screen.findByText(shown)).toBeDefined()
  })

  it('should read /health again on Refresh', async () => {
    // Arrange
    const user = userEvent.setup()
    const health = fakeHealth(() => Response.json(passingReport))
    renderServerPage({ domain: 'ruth.relay.example.com', health })
    await screen.findByText('Its /health answers pass.')

    // Act
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    // Assert
    await waitFor(() => {
      expect(health.urls).toHaveLength(2)
    })
  })

  it('should read no /health while the server is stopped', async () => {
    // Arrange
    const health = fakeHealth(() => Response.json(passingReport))

    // Act
    renderServerPage({ domain: 'lab.rathole.example.com', health })

    // Assert
    expect(
      await screen.findByText("It stopped with an error: the server's config couldn't be built")
    ).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Health checks' })).toBeNull()
    expect(health.urls).toEqual([])
  })

  it('should read /health again for a new run, and stay current with server-status events', async () => {
    // Arrange
    const events = fakeEvents()
    const health = fakeHealth(() => Response.json(passingReport))
    renderServerPage({ domain: 'ruth.relay.example.com', health, events })
    await screen.findByText('Its /health answers pass.')

    // Act
    events.emit('server-status', golden.serverStatuses.stoppedByThePlatform)

    // Assert
    expect(await screen.findByText('The system ended its time in the background.')).toBeDefined()
    expect(screen.getByText("The system's time limit for background work ran out.")).toBeDefined()
    expect(within(await hero()).getByRole('status').textContent).toMatch(/Stopped$/)
    expect(screen.queryByRole('heading', { name: 'Health checks' })).toBeNull()

    // Act
    events.emit('server-status', {
      ...golden.serverStatuses.runningAndReachable,
      runningSince: '2026-10-06T18:00:00Z',
    })

    // Assert
    expect(await screen.findByText('Its /health answers pass.')).toBeDefined()
    expect(health.urls).toHaveLength(2)
    expect(within(await hero()).getByRole('status').textContent).toMatch(/Running$/)
  })

  /** `instant`, an RFC 3339 string, as the page shows its dates. */
  const shownInstant = (instant: string): string => formatInstant(DateTime.unsafeMake(instant))

  /** The row of the Certificate section titled `title`. */
  const certificateRow = (title: string): HTMLElement => {
    const row = within(sectionTitled('Certificate')).getByText(title).closest('li')
    if (row === null) throw new Error(`no ${title} row`)
    return row
  }

  it.each([
    ['neverRun', 'None yet. The server orders one when it runs.', false],
    ['runningCacheFailed', 'Ordering one from the certificate authority.', false],
    ['runningAndReachable', 'Valid.', false],
    [
      'runningRenewalFailed',
      'Valid, and due for renewal, which the server makes while it runs.',
      false,
    ],
    ['stoppedWithAnError', 'Expired. The server renews it when it starts.', false],
    ['startingCaUnreachable', 'No valid certificate: ordering one is failing.', true],
    ['stoppedByThePlatform', "The certificate stored on this device couldn't be read.", true],
  ] as const)(
    'should show the certificate of a %s status as "%s", as a failure only when it is one',
    async (statusName, text, failure) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
      })

      // Assert
      expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
      const status = certificateRow('Status')
      expect(status.textContent).toContain(text)
      expect(/tone-danger/.test(status.className)).toBe(failure)
    }
  )

  it("should show the server's certificate authority, the held certificate's validity and fingerprint, and no error when there is none", async () => {
    // Arrange
    const { held } = golden.listedServers[0].certificate

    // Act
    renderServerPage({ domain: 'ruth.relay.example.com' })

    // Assert
    expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
    expect(certificateRow('Certificate authority').textContent).toMatch(/Let's Encrypt$/)
    expect(within(sectionTitled('Certificate')).queryByText('State shown for')).toBeNull()
    expect(certificateRow('Valid from').textContent).toContain(shownInstant(held.notBefore))
    expect(certificateRow('Valid until').textContent).toContain(shownInstant(held.notAfter))
    expect(certificateRow('SHA-256 fingerprint').textContent).toContain(held.fingerprint)
    expect(within(sectionTitled('Certificate')).queryByText('Last error')).toBeNull()
  })

  it("should show the server's certificate authority, and the one the state is for when it differs", async () => {
    // Arrange
    const host = hostWith({
      servers: () =>
        Promise.resolve(listedWithRuthStatus(golden.serverStatuses.runningRenewalFailed)),
      answers: { server_update: () => Promise.resolve(null) },
    })
    const user = userEvent.setup()
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: '/servers/ruth.relay.example.com',
    })
    await screen.findByRole('heading', { name: 'Certificate' })

    // Act
    await user.clear(screen.getByLabelText('Launcher'))
    await user.type(screen.getByLabelText('Launcher'), 'https://launcher.example.com/')
    await user.click(screen.getByRole('button', { name: 'Save launcher' }))

    // Assert
    expect(certificateRow('Certificate authority').textContent).toMatch(/Let's Encrypt$/)
    expect(certificateRow('State shown for').textContent).toMatch(
      /Let's Encrypt staging, which browsers don't trust$/
    )
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'ruth.relay.example.com',
        launcherUrl: 'https://launcher.example.com/',
        certificateAuthority: 'letsEncrypt',
      },
    })
  })

  it('should show the issuer, and no validity or fingerprint, while no certificate is held', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      servers: listedWithRuthStatus(golden.serverStatuses.neverRun),
    })

    // Assert
    expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
    expect(certificateRow('Certificate authority').textContent).toMatch(/Let's Encrypt$/)
    const certificate = within(sectionTitled('Certificate'))
    expect(certificate.queryByText('Valid from')).toBeNull()
    expect(certificate.queryByText('Valid until')).toBeNull()
    expect(certificate.queryByText('SHA-256 fingerprint')).toBeNull()
  })

  /** `golden.serverStatuses.startingCaUnreachable` with its certificate's `lastError` set to `lastError`. */
  const withLastError = (lastError: unknown): { readonly certificate: unknown } => ({
    ...golden.serverStatuses.startingCaUnreachable,
    certificate: { ...golden.serverStatuses.startingCaUnreachable.certificate, lastError },
  })

  it.each([
    [
      'a rate limit with no retry time',
      withLastError({ kind: 'rateLimited' }),
      "The certificate authority's rate limit was reached.",
    ],
    [
      'a failed challenge, with its detail',
      golden.serverStatuses.runningRenewalFailed,
      "The certificate authority couldn't validate this server's domain: Connection refused",
    ],
    [
      'a failed challenge with no detail',
      withLastError({ kind: 'challengeFailed' }),
      "The certificate authority couldn't validate this server's domain.",
    ],
    [
      'an unreachable CA',
      golden.serverStatuses.startingCaUnreachable,
      "The certificate authority couldn't be reached: http request error: io error: Connection refused",
    ],
    [
      'another order failure',
      withLastError({ kind: 'other', message: 'the order was invalid' }),
      'Ordering failed: the order was invalid',
    ],
    [
      'a cache fault',
      golden.serverStatuses.runningCacheFailed,
      "The certificates on this device couldn't be read or written: account cache store: disk full",
    ],
  ] as const)('should describe %s as the last error', async (_, status, text) => {
    // Act
    renderServerPage({ domain: 'ruth.relay.example.com', servers: listedWithRuthStatus(status) })

    // Assert
    expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
    const lastError = certificateRow('Last error')
    expect(lastError.textContent).toContain(text)
    expect(lastError.className).toMatch(/tone-danger/)
  })

  it('should say when the CA said to retry a rate limit, and that it has passed once it has', async () => {
    // Arrange
    const { retryAfter } = golden.serverStatuses.runningUnreachable.certificate.lastError
    const said = `The certificate authority's rate limit was reached; it said to retry after ${shownInstant(retryAfter)}`
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(retryAfter) - 60_000 })
    try {
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses.runningUnreachable),
      })
      expect(await screen.findByText(`${said}.`)).toBeDefined()

      // Act
      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      // Assert
      expect(await screen.findByText(`${said}; that time has passed.`)).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('should show the certificate state of each server-status event', async () => {
    // Arrange
    const events = fakeEvents()
    renderServerPage({ domain: 'ruth.relay.example.com', events })
    await screen.findByRole('heading', { name: 'Certificate' })

    // Act
    events.emit('server-status', golden.serverStatuses.stoppedByThePlatform)

    // Assert
    expect(
      await screen.findByText("The certificate stored on this device couldn't be read.")
    ).toBeDefined()
    expect(certificateRow('Last error').textContent).toContain(
      'reading the certificate cache failed: Permission denied (os error 13)'
    )
    expect(within(sectionTitled('Certificate')).queryByText('SHA-256 fingerprint')).toBeNull()
  })

  it('should send a new token, clear it once accepted, and never show it', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'ruth.relay.example.com',
      answers: { server_set_credentials: () => Promise.resolve(null) },
    })
    const field = await screen.findByLabelText('New tunnel token')
    expect(field).toHaveProperty('value', '')
    expect(field).toHaveProperty('type', 'password')

    // Act
    await user.type(field, 'tunnel-token-123')
    await user.click(screen.getByRole('button', { name: 'Save token' }))

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_set_credentials',
      args: { domain: 'ruth.relay.example.com', token: 'tunnel-token-123' },
    })
    await waitFor(() => {
      expect(field).toHaveProperty('value', '')
    })
    expect(document.body.textContent).not.toContain('tunnel-token-123')
  })

  it("should show the host's refusal of a new token, without the token", async () => {
    // Arrange
    const user = userEvent.setup()
    const refusal = {
      kind: 'signedRequestRejected',
      message: "the relay didn't accept the tunnel name and token",
    }
    renderServerPage({
      domain: 'ruth.relay.example.com',
      answers: { server_set_credentials: () => Promise.reject(refusal) },
    })

    // Act
    await user.type(await screen.findByLabelText('New tunnel token'), 'wrong-token')
    await user.click(screen.getByRole('button', { name: 'Save token' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain(refusal.message)
    expect(document.body.textContent).not.toContain('wrong-token')
  })

  it('should save an edited launcher with the certificate authority unchanged', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'lab.rathole.example.com',
      answers: { server_update: () => Promise.resolve(null) },
    })
    const field = await screen.findByLabelText('Launcher')
    const save = screen.getByRole('button', { name: 'Save launcher' })
    expect(save).toHaveProperty('disabled', true)

    // Act
    await user.clear(field)
    await user.type(field, 'https://launcher.example.com/app')
    await user.click(save)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'lab.rathole.example.com',
        launcherUrl: 'https://launcher.example.com/app',
        certificateAuthority: 'letsEncryptStaging',
      },
    })
    await waitFor(() => {
      expect(save).toHaveProperty('disabled', true)
    })
  })

  it('should reset the launcher to the default at once, and offer no reset when it is the default', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'lab.rathole.example.com',
      answers: { server_update: () => Promise.resolve(null) },
    })

    // Act
    await user.click(await screen.findByRole('button', { name: 'Reset to default' }))

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'lab.rathole.example.com',
        launcherUrl: DEFAULT_LAUNCHER_URL,
        certificateAuthority: 'letsEncryptStaging',
      },
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()
    })
    expect(screen.getByLabelText('Launcher')).toHaveProperty('value', DEFAULT_LAUNCHER_URL)
    cleanup()

    // Act
    renderServerPage({ domain: 'ruth.relay.example.com' })

    // Assert
    expect(await screen.findByLabelText('Launcher')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()
  })

  it.each([
    ['the default with its host in another case', 'https://WildflowerHealth.IO/app', false],
    ['the default with its default port', 'https://wildflowerhealth.io:443/app', false],
    ['a launcher that is not a URL', 'not a url', true],
  ] as const)(
    'should compare a launcher with the default as URLs: %s',
    async (_, launcherUrl, offersReset) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: [{ ...golden.listedServers[0], launcherUrl }, golden.listedServers[1]],
      })

      // Assert
      expect(await screen.findByLabelText('Launcher')).toHaveProperty('value', launcherUrl)
      expect(screen.queryByRole('button', { name: 'Reset to default' }) !== null).toBe(offersReset)
    }
  )

  it('should remove the server only once its domain is typed and confirmed, then return to the list', async () => {
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
      path: '/servers/lab.rathole.example.com',
      httpClient: fakeHealth(() => Response.json(passingReport)).layer,
    })
    const remove = await screen.findByRole('button', { name: 'Remove' })

    // Act
    await user.click(remove)
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(host.seen.map(({ command }) => command)).not.toContain('server_remove')

    // Act
    await user.click(remove)
    const confirm = within(confirmDialog()).getByRole('button', { name: 'Remove' })

    // Assert
    expect(confirm).toHaveProperty('disabled', true)

    // Act
    await user.type(
      within(confirmDialog()).getByLabelText('Type lab.rathole.example.com to confirm'),
      'lab.rathole.example.com'
    )
    await user.click(confirm)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_remove',
      args: { domain: 'lab.rathole.example.com' },
    })
    expect(await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })).toBeDefined()
    expect(screen.queryByRole('listitem', { name: 'lab.rathole.example.com' })).toBeNull()
  })

  it("should show the host's refusal, and stay on the page, when the host can't remove the server", async () => {
    // Arrange
    const user = userEvent.setup()
    renderServerPage({
      domain: 'lab.rathole.example.com',
      answers: { server_remove: () => Promise.reject(golden.commandErrors[2]) },
    })
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    await user.type(
      within(confirmDialog()).getByLabelText('Type lab.rathole.example.com to confirm'),
      'lab.rathole.example.com'
    )

    // Act
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain(
      golden.commandErrors[2].message
    )
    expect(screen.getByRole('heading', { name: 'Server' })).toBeDefined()
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
