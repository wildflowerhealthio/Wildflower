import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BaseRootProps } from '@wildflowerhealthio/servers-react'
import { Effect } from 'effect'
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../servers/servers-wire-golden.json' with { type: 'json' }
import { HostShell, type RecorderTransport } from './host-shell.tsx'

// The base is a whole app with its own tests; here it stands in as a screen
// with state of its own, so the shell's keeping it mounted is observable, and
// a link of its own on the shell's history, so the base's own navigation is.
vi.mock('@wildflowerhealthio/servers-react', () => ({
  BaseRoot: ({ history }: { readonly history: RouterHistory }): JSX.Element => {
    const [presses, setPresses] = useState(0)
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setPresses((count) => count + 1)
          }}
        >
          Base pressed {presses}
        </button>
        <button
          type="button"
          onClick={() => {
            history.push('/settings')
          }}
        >
          Base Host Settings
        </button>
      </>
    )
  },
}))

afterEach(() => {
  cleanup()
})

/** A host event listener the test can fire, standing in for Tauri's `listen`. */
interface FakeHostEvents {
  readonly listen: BaseRootProps['listen']
  readonly emit: (event: string, payload: unknown) => void
}

const fakeHostEvents = (): FakeHostEvents => {
  const handlers = new Map<string, (event: { readonly payload: unknown }) => void>()
  return {
    listen: (event, handler) => {
      handlers.set(event, handler)
      return Promise.resolve(() => {
        handlers.delete(event)
      })
    },
    emit: (event, payload) => {
      handlers.get(event)?.({ payload })
    },
  }
}

/** A transport that has told the host the page is ready, and drops what it is sent. */
const readyRecorderTransport = (): Promise<RecorderTransport> =>
  Promise.resolve({
    sendMessage: () => Effect.void,
    coordinator: { register: () => Effect.void, unregister: () => Effect.void },
  })

const BASE_PROPS = {
  invoke: () => Promise.reject(new Error('no host commands in this test')),
  backgroundServiceStartConfig: { serviceLabel: 'Servers', foregroundServiceType: 'none' },
  defaultLauncherUrl: 'https://wildflowerhealth.io/launcher/',
  telemetry: { dsn: '', app: 'host-app' },
} as const

const renderShell = async ({
  hostEvents = fakeHostEvents(),
  history = createMemoryHistory({ initialEntries: ['/'] }),
  recorderTransport = readyRecorderTransport(),
}: {
  readonly hostEvents?: FakeHostEvents
  readonly history?: RouterHistory
  readonly recorderTransport?: Promise<RecorderTransport>
} = {}): Promise<RouterHistory> => {
  render(
    <HostShell
      base={{ ...BASE_PROPS, listen: hostEvents.listen }}
      history={history}
      recorderTransport={recorderTransport}
      revealFile={() => Promise.resolve()}
    />
  )
  // Let the transport's promise settle into the Recorder.
  await act(async () => {})
  return history
}

/** The link in the shell's bar named `name`. */
const linkOf = (name: string): HTMLElement =>
  within(screen.getByRole('navigation', { name: 'Wildflower Host' })).getByRole('link', { name })

/** Whether `element` is on a page the shell hides. */
const isHidden = (element: HTMLElement): boolean => element.closest('[hidden]') !== null

/** Whether the base's page shows, found by its stand-in's button. */
const baseShows = (): boolean =>
  !isHidden(screen.getByRole('button', { name: /^Base pressed/, hidden: true }))

/** Whether the Recorder's page shows, found by its heading. */
const recorderShows = (): boolean =>
  !isHidden(screen.getByRole('heading', { name: 'Recorder', hidden: true }))

describe('HostShell', () => {
  it('should open on the base at /, with the Servers link current and Recorder beside it', async () => {
    // Act
    await renderShell()

    // Assert
    const nav = screen.getByRole('navigation', { name: 'Wildflower Host' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Servers', 'Recorder'])
    expect(linkOf('Servers').getAttribute('aria-current')).toBe('page')
    expect(linkOf('Recorder').getAttribute('aria-current')).toBeNull()
    expect(linkOf('Recorder').getAttribute('href')).toBe('/recorder')
    expect(baseShows()).toBe(true)
    expect(recorderShows()).toBe(false)
  })

  it('should show the Recorder page at /recorder', async () => {
    // Act
    await renderShell({ history: createMemoryHistory({ initialEntries: ['/recorder'] }) })

    // Assert
    expect(linkOf('Recorder').getAttribute('aria-current')).toBe('page')
    expect(recorderShows()).toBe(true)
    expect(baseShows()).toBe(false)
    expect(screen.getByRole('heading', { name: 'Recorder' })).toBeDefined()
  })

  it('should navigate to /recorder from the Recorder link', async () => {
    // Arrange
    const history = await renderShell()
    const user = userEvent.setup()

    // Act
    await user.click(linkOf('Recorder'))

    // Assert
    expect(history.location.pathname).toBe('/recorder')
    expect(linkOf('Recorder').getAttribute('aria-current')).toBe('page')
    expect(recorderShows()).toBe(true)
    expect(baseShows()).toBe(false)
  })

  it("should go back to the base's last location from the Servers link", async () => {
    // Arrange
    const history = await renderShell()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Base Host Settings' }))
    await user.click(linkOf('Recorder'))

    // Assert
    expect(linkOf('Servers').getAttribute('href')).toBe('/settings')

    // Act
    await user.click(linkOf('Servers'))

    // Assert
    expect(history.location.pathname).toBe('/settings')
    expect(linkOf('Servers').getAttribute('aria-current')).toBe('page')
    expect(baseShows()).toBe(true)
  })

  it('should keep each page where it was while the other is shown', async () => {
    // Arrange
    await renderShell()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Base pressed 0' }))
    await user.click(linkOf('Recorder'))
    await user.type(screen.getByLabelText('URL'), 'https://example.com')

    // Act
    await user.click(linkOf('Servers'))
    await user.click(linkOf('Recorder'))

    // Assert
    expect(screen.getByLabelText<HTMLInputElement>('URL').value).toBe('https://example.com')
    expect(screen.getByRole('button', { name: 'Base pressed 1', hidden: true })).toBeDefined()
  })

  it('should navigate to the base when a consent comes to wait on a server', async () => {
    // Arrange
    const hostEvents = fakeHostEvents()
    const history = await renderShell({ hostEvents })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Base Host Settings' }))
    await user.click(linkOf('Recorder'))
    const [waiting, , cleared] = golden.pendingConsents

    // Act — a server with nothing waiting any more leaves the Recorder showing.
    act(() => {
      hostEvents.emit('pending-consent', cleared)
    })

    // Assert
    expect(history.location.pathname).toBe('/recorder')

    // Act
    act(() => {
      hostEvents.emit('pending-consent', waiting)
    })

    // Assert
    expect(history.location.pathname).toBe('/settings')
    expect(baseShows()).toBe(true)
    expect(recorderShows()).toBe(false)
  })

  it('should say so when the recorder cannot connect to the host', async () => {
    // Act
    await renderShell({ recorderTransport: Promise.reject(new Error('listen refused')) })

    // Assert
    expect(screen.getByText("The recorder couldn't connect", { exact: false })).toBeDefined()
  })
})
