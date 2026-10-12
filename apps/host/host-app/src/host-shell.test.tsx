import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BaseRootProps } from '@wildflowerhealthio/servers-react'
import { Effect } from 'effect'
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../servers/servers-wire-golden.json' with { type: 'json' }
import { HostShell, type RecorderTransport } from './host-shell.tsx'

// The base is a whole app with its own tests; here it stands in as a screen
// with state of its own, so the shell's keeping it mounted is observable.
vi.mock('@wildflowerhealthio/servers-react', () => ({
  BaseRoot: (): JSX.Element => {
    const [presses, setPresses] = useState(0)
    return (
      <button
        type="button"
        onClick={() => {
          setPresses((count) => count + 1)
        }}
      >
        Base pressed {presses}
      </button>
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

const renderShell = async (hostEvents: FakeHostEvents = fakeHostEvents()): Promise<void> => {
  render(
    <HostShell
      base={{
        invoke: () => Promise.reject(new Error('no host commands in this test')),
        listen: hostEvents.listen,
        backgroundServiceStartConfig: { serviceLabel: 'Servers', foregroundServiceType: 'none' },
        defaultLauncherUrl: 'https://wildflowerhealth.io/launcher/',
        telemetry: { dsn: '', app: 'host-app' },
      }}
      recorderTransport={readyRecorderTransport()}
      revealFile={() => Promise.resolve()}
    />
  )
  // Let the transport's promise settle into the Recorder tab.
  await act(async () => {})
}

/** The panel a tab controls. */
const panelOf = (tabName: string): HTMLElement => {
  const panelId = screen.getByRole('tab', { name: tabName }).getAttribute('aria-controls') ?? ''
  const panel = document.getElementById(panelId)
  if (panel === null) throw new Error(`no panel for the ${tabName} tab`)
  return panel
}

describe('HostShell', () => {
  it('should open on the Servers tab with the Recorder tab beside it', async () => {
    // Act
    await renderShell()

    // Assert
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Servers',
      'Recorder',
    ])
    expect(screen.getByRole('tab', { name: 'Servers' }).getAttribute('aria-selected')).toBe('true')
    expect(panelOf('Servers').hidden).toBe(false)
    expect(panelOf('Recorder').hidden).toBe(true)
  })

  it('should show the Recorder page on the Recorder tab', async () => {
    // Arrange
    await renderShell()
    const user = userEvent.setup()

    // Act
    await user.click(screen.getByRole('tab', { name: 'Recorder' }))

    // Assert
    expect(screen.getByRole('tab', { name: 'Recorder' }).getAttribute('aria-selected')).toBe('true')
    expect(panelOf('Recorder').hidden).toBe(false)
    expect(panelOf('Servers').hidden).toBe(true)
    expect(screen.getByRole('heading', { name: 'Recorder' })).toBeDefined()
  })

  it('should keep each tab where it was while the other is shown', async () => {
    // Arrange
    await renderShell()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Base pressed 0' }))
    await user.click(screen.getByRole('tab', { name: 'Recorder' }))
    await user.type(screen.getByLabelText('URL'), 'https://example.com')

    // Act
    await user.click(screen.getByRole('tab', { name: 'Servers' }))
    await user.click(screen.getByRole('tab', { name: 'Recorder' }))

    // Assert
    expect(screen.getByLabelText<HTMLInputElement>('URL').value).toBe('https://example.com')
    expect(screen.getByRole('button', { name: 'Base pressed 1', hidden: true })).toBeDefined()
  })

  it('should show the Servers tab when a consent comes to wait on a server', async () => {
    // Arrange
    const hostEvents = fakeHostEvents()
    await renderShell(hostEvents)
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: 'Recorder' }))
    const [waiting, , cleared] = golden.pendingConsents

    // Act — a server with nothing waiting any more leaves the tab alone.
    act(() => {
      hostEvents.emit('pending-consent', cleared)
    })

    // Assert
    expect(panelOf('Recorder').hidden).toBe(false)

    // Act
    act(() => {
      hostEvents.emit('pending-consent', waiting)
    })

    // Assert
    expect(panelOf('Servers').hidden).toBe(false)
    expect(panelOf('Recorder').hidden).toBe(true)
  })

  it('should say so when the recorder cannot connect to the host', async () => {
    // Act
    render(
      <HostShell
        base={{
          invoke: () => Promise.reject(new Error('no host commands in this test')),
          listen: fakeHostEvents().listen,
          backgroundServiceStartConfig: { serviceLabel: 'Servers', foregroundServiceType: 'none' },
          defaultLauncherUrl: 'https://wildflowerhealth.io/launcher/',
          telemetry: { dsn: '', app: 'host-app' },
        }}
        recorderTransport={Promise.reject(new Error('listen refused'))}
        revealFile={() => Promise.resolve()}
      />
    )
    await act(async () => {})

    // Assert
    expect(panelOf('Recorder').textContent).toContain("The recorder couldn't connect")
  })
})
