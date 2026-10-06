import { createMemoryHistory } from '@tanstack/react-router'
import { cleanup, render, type RenderResult, screen, waitFor, within } from '@testing-library/react'
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

/**
 * A host whose notification permission reads `permission`, whose version is
 * `version`, and whose `servers_list` answers `servers`.
 */
const hostWith = ({
  permission = true,
  version = '0.4.0',
  servers = () => Promise.resolve([]),
}: {
  readonly permission?: boolean | null
  readonly version?: string
  readonly servers?: () => Promise<unknown>
} = {}): FakeHost =>
  fakeHost({
    'plugin:notification|is_permission_granted': () => Promise.resolve(permission),
    'plugin:app|version': () => Promise.resolve(version),
    servers_list: servers,
  })

const renderBase = ({
  invoke,
  storage,
  path = '/',
}: {
  readonly invoke: Context.Tag.Service<TauriInvoke>
  readonly storage: ConsentStorage
  readonly path?: string
}): RenderResult =>
  render(
    <BaseRoot
      invoke={invoke}
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

describe('the server list', () => {
  it('should list each server the host answers by its domain', async () => {
    // Arrange
    const host = hostWith({ servers: () => Promise.resolve(golden.listedServers) })

    // Act
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })

    // Assert
    expect(await screen.findByText('ruth.relay.example.com')).toBeDefined()
    expect(screen.getByText('lab.rathole.example.com')).toBeDefined()
    expect(screen.queryByText('No servers yet')).toBeNull()
  })

  it("should show the host's error when it can't read the servers, and read them again on retry", async () => {
    // Arrange
    const user = userEvent.setup()
    const message = "the server registry has format version 2, which this build doesn't read"
    let answer: () => Promise<unknown> = () => Promise.reject({ kind: 'registry', message })
    const host = hostWith({ servers: () => answer() })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
    })

    // Assert
    expect(
      await screen.findByRole('heading', { name: "The servers on this device couldn't be read" })
    ).toBeDefined()
    expect(screen.getByText(new RegExp(message))).toBeDefined()

    // Act
    answer = () => Promise.resolve([])
    await user.click(screen.getByRole('button', { name: /retry/i }))

    // Assert
    expect(await screen.findByText('No servers yet')).toBeDefined()
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
