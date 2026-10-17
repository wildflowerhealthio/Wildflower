import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import type { ServersRouterContext } from '@wildflowerhealthio/servers-react'
import { type ConsentStorage, writeConsent } from '@wildflowerhealthio/telemetry-core'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import recorderGolden from '../../recorder/recorder-wire-golden.json' with { type: 'json' }
import { HostRoot } from './host-root.tsx'
import type { RecorderTransport } from './router-context.ts'

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
  for (const [method, descriptor] of dialogMethodDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
  }
})

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
const storageAnswered = (): ConsentStorage => {
  const storage = mapConsentStorage()
  writeConsent(storage, {
    version: WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY.version,
    decidedAt: '2026-10-06T12:00:00.000Z',
    crashReports: false,
    performance: false,
  })
  return storage
}

/** What the fake host answers each command with; any other is refused. */
const HOST_ANSWERS: Readonly<Record<string, unknown>> = {
  'plugin:background-service|configure_recovery': null,
  'plugin:notification|is_permission_granted': true,
  'plugin:app|version': '0.4.0',
  servers_list: [],
  recorder_save_folder: recorderGolden.commands.recorder_save_folder,
  recorder_bookmarks: recorderGolden.commands.recorder_bookmarks,
  recorder_bookmark_recorded: recorderGolden.commands.recorder_bookmarks,
}

const invoke = (command: string): Promise<unknown> =>
  command in HOST_ANSWERS
    ? Promise.resolve(HOST_ANSWERS[command])
    : Promise.reject(new Error(`unexpected command ${command}`))

/** A host event listener that hears nothing, standing in for Tauri's `listen`. */
const listenToNoHostEvent: ServersRouterContext.ListenToHostEvent = () => Promise.resolve(() => {})

/** A Recorder transport that has told the host the page is ready, and the tags it was sent. */
interface FakeRecorderTransport {
  readonly transport: Promise<RecorderTransport>
  readonly sentTags: readonly string[]
}

const readyRecorderTransport = (): FakeRecorderTransport => {
  const sentTags: string[] = []
  return {
    sentTags,
    transport: Promise.resolve({
      sendMessage: (message) =>
        Effect.sync(() => {
          sentTags.push(message._tag)
        }),
      coordinator: { register: () => Effect.void, unregister: () => Effect.void },
    }),
  }
}

const renderHost = async ({
  path = '/',
  storage = storageAnswered(),
  recorderTransport = readyRecorderTransport().transport,
}: {
  readonly path?: string
  readonly storage?: ConsentStorage
  readonly recorderTransport?: Promise<RecorderTransport>
} = {}): Promise<RouterHistory> => {
  const history = createMemoryHistory({ initialEntries: [path] })
  render(
    <HostRoot
      base={{
        invoke,
        platform: 'desktop',
        listen: listenToNoHostEvent,
        listenToNotificationTaps: () => Promise.reject(new Error('no notification taps here')),
        backgroundServiceStartConfig: { serviceLabel: 'Servers', foregroundServiceType: 'none' },
        defaultLauncherUrl: 'https://launcher.wildflowerhealth.io/',
        defaultAuthorizationUrl: 'https://authorization.wildflowerhealth.io/',
        telemetry: { dsn: '', app: 'host-app' },
        storage,
      }}
      history={history}
      recorderTransport={recorderTransport}
      revealFile={() => Promise.resolve()}
    />
  )
  // Let the root's loader settle the Recorder's transport.
  await act(async () => {})
  return history
}

/** The bar of links, once it shows. */
const findNav = (): Promise<HTMLElement> =>
  screen.findByRole('navigation', { name: 'Wildflower Host' })

/** The link in the bar named `name`. */
const linkOf = (name: string): HTMLElement =>
  within(screen.getByRole('navigation', { name: 'Wildflower Host' })).getByRole('link', { name })

describe('HostRoot', () => {
  it("should show only the base's consent dialog, without the bar, until the user answers", async () => {
    // Act
    await renderHost({ storage: mapConsentStorage() })

    // Assert
    expect(document.querySelector('dialog[open]')).not.toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Wildflower Host' })).toBeNull()
  })

  it('should open the server list from /, with the Servers link current and Recorder beside it', async () => {
    // Act
    const history = await renderHost()

    // Assert
    const nav = await findNav()
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Servers', 'Recorder'])
    expect(await screen.findByText('No servers yet')).toBeDefined()
    expect(history.location.pathname).toBe('/servers')
    expect(linkOf('Servers').getAttribute('aria-current')).toBe('page')
    expect(linkOf('Recorder').getAttribute('aria-current')).toBeNull()
    expect(linkOf('Recorder').getAttribute('href')).toBe('/recorder')
  })

  it('should show the Recorder page at /recorder, with the Recorder link current', async () => {
    // Act
    await renderHost({ path: '/recorder' })

    // Assert
    expect(await screen.findByRole('heading', { name: 'Recorder' })).toBeDefined()
    expect(linkOf('Recorder').getAttribute('aria-current')).toBe('page')
    expect(linkOf('Servers').getAttribute('aria-current')).toBeNull()
  })

  it('should navigate to /recorder from the Recorder link', async () => {
    // Arrange
    const history = await renderHost()
    const user = userEvent.setup()
    await findNav()

    // Act
    await user.click(linkOf('Recorder'))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Recorder' })).toBeDefined()
    expect(history.location.pathname).toBe('/recorder')
    expect(linkOf('Recorder').getAttribute('aria-current')).toBe('page')
  })

  it("should go back to the base's last location from the Servers link", async () => {
    // Arrange
    const history = await renderHost()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('link', { name: 'Host Settings' }))
    await user.click(linkOf('Recorder'))
    await screen.findByRole('heading', { name: 'Recorder' })

    // Assert
    expect(linkOf('Servers').getAttribute('href')).toBe('/settings')

    // Act
    await user.click(linkOf('Servers'))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Host Settings' })).toBeDefined()
    expect(history.location.pathname).toBe('/settings')
    expect(linkOf('Servers').getAttribute('aria-current')).toBe('page')
  })

  it('should keep a recording going while the base shows', async () => {
    // Arrange
    const recorder = readyRecorderTransport()
    await renderHost({ path: '/recorder', recorderTransport: recorder.transport })
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('URL'), 'https://example.com')
    await user.click(screen.getByRole('button', { name: 'Start recording' }))

    // Act
    await user.click(linkOf('Servers'))
    await screen.findByText('No servers yet')
    await user.click(linkOf('Recorder'))

    // Assert
    expect(await screen.findByText('0 responses recorded')).toBeDefined()
    expect(screen.getByLabelText<HTMLInputElement>('URL').value).toBe('https://example.com')
    expect(screen.getByRole('button', { name: 'Stop & Save' })).toBeDefined()
    expect(recorder.sentTags).toEqual(['Open'])
  })

  it('should say so on the Recorder page when the recorder cannot connect, and still show the base', async () => {
    // Arrange
    await renderHost({
      path: '/recorder',
      recorderTransport: Promise.reject(new Error('listen refused')),
    })
    const user = userEvent.setup()

    // Assert
    expect(await screen.findByText("The recorder couldn't connect", { exact: false })).toBeDefined()

    // Act
    await user.click(linkOf('Servers'))

    // Assert
    expect(await screen.findByText('No servers yet')).toBeDefined()
  })

  it('should show Page not found under the bar at a path nothing names, with neither link current', async () => {
    // Act
    await renderHost({ path: '/nowhere' })

    // Assert
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeDefined()
    expect(linkOf('Servers').getAttribute('aria-current')).toBeNull()
    expect(linkOf('Recorder').getAttribute('aria-current')).toBeNull()
    expect(linkOf('Servers').getAttribute('href')).toBe('/servers')
  })
})
