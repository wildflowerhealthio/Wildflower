import { act, cleanup, render, screen } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import { AuthStateProvider, HostAuthed } from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  ActiveDeviceUserCodeProvider,
  makeActiveDeviceUserCodeStore,
} from '../../active-device-consent/index.ts'
import { makeEmbeddedAuthStateStore } from '../../client/auth-state-store.ts'

// The host's onClose handler, captured so a test can simulate the user
// dismissing the dialog (× / ESC / backdrop) without <dialog> shadow behaviour.
let lastDialogClose: (() => void) | null = null

vi.mock('react-tundraish', () => ({
  // Minimal Dialog stub: renders its children whenever `open`, and
  // surfaces the `dismissable` and `title` props as data attributes so
  // the assertions can pin them without reaching for portals or
  // <dialog> shadow behaviour.
  Dialog: ({
    open,
    dismissable = true,
    title,
    onClose,
    children,
  }: {
    readonly open: boolean
    readonly dismissable?: boolean
    readonly title?: ReactNode
    readonly onClose: () => void
    readonly children: ReactNode
  }): JSX.Element | null => {
    lastDialogClose = onClose
    return open ? (
      <div
        data-testid="dialog"
        data-dismissable={String(dismissable)}
        data-title={typeof title === 'string' ? title : 'unknown'}
      >
        {children}
      </div>
    ) : null
  },
}))

// Replace the suspense-fetching consent body with a marker that
// records the `userCode` it was rendered with — pins that the modal
// host actually drives the form's identity off the active user code
// (and not, say, a stale closure).
let lastFormDone: (() => void) | null = null
vi.mock('./device-consent-form.tsx', () => ({
  DeviceConsentForm: ({
    consent,
    onDone,
  }: {
    readonly consent: { readonly userCode: string }
    readonly onDone: () => void
  }): JSX.Element => {
    lastFormDone = onDone
    return <div data-testid="form" data-user-code={consent.userCode} />
  },
}))

vi.mock('../../queries/index.ts', () => ({
  useDeviceConsentQuery: (userCode: string) => ({
    data: {
      userCode,
      clientId: 'client-id',
      clientName: 'Client',
      requestedScopes: ['openid'],
    },
  }),
}))

import { DeviceConsentModalHost } from './device-consent-modal-host.tsx'

const renderWithProviders = (
  consentStore: ReturnType<typeof makeActiveDeviceUserCodeStore>,
  options: { readonly authed?: boolean } = {}
): ReturnType<typeof makeEmbeddedAuthStateStore> => {
  const tokenStore = makeEmbeddedAuthStateStore()
  if (options.authed === true) {
    tokenStore.setAuthState(HostAuthed())
  }
  render(
    <AuthStateProvider store={tokenStore}>
      <ActiveDeviceUserCodeProvider store={consentStore}>
        <DeviceConsentModalHost />
      </ActiveDeviceUserCodeProvider>
    </AuthStateProvider>
  )
  return tokenStore
}

describe('DeviceConsentModalHost', () => {
  beforeEach(() => {
    lastFormDone = null
    lastDialogClose = null
  })

  afterEach(() => {
    cleanup()
  })

  test('renders nothing while there is no auth token (pre-auth window)', async () => {
    const store = makeActiveDeviceUserCodeStore()
    renderWithProviders(store)

    // Even when a device-consent event somehow arrives before auth, the
    // modal stays inert — no tokenless fetch.
    await act(async () => {
      store.setActiveUserCode('ABC-123')
      await Promise.resolve()
    })

    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  test('renders nothing while the active userCode is null', () => {
    const store = makeActiveDeviceUserCodeStore()
    renderWithProviders(store, { authed: true })

    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  test('opens a dismissable dialog with the form when a userCode arrives', async () => {
    const store = makeActiveDeviceUserCodeStore()
    renderWithProviders(store, { authed: true })

    await act(async () => {
      store.setActiveUserCode('ABC-123')
      await Promise.resolve()
    })

    const dialog = screen.getByTestId('dialog')
    // Dismissable: the × / ESC closes without deciding (the request stays
    // pending, still answerable from Settings).
    expect(dialog.dataset['dismissable']).toBe('true')
    expect(dialog.dataset['title']).toBe('Device Authorization')
    expect(screen.getByTestId('form').dataset['userCode']).toBe('ABC-123')
  })

  test('a dismissal closes the popup without deciding and it stays closed for that userCode', async () => {
    const store = makeActiveDeviceUserCodeStore()
    renderWithProviders(store, { authed: true })

    await act(async () => {
      store.setActiveUserCode('ABC-123')
      await Promise.resolve()
    })
    expect(screen.getByTestId('dialog')).toBeDefined()

    // The Dialog's onClose (× / ESC / backdrop) marks the code handled — the
    // popup closes with no approve/deny sent, and does not re-open while the
    // host still reports the same active code.
    await act(async () => {
      lastDialogClose?.()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  test('local handledUserCode closes the popup immediately on form.onDone, before the host clears', async () => {
    const store = makeActiveDeviceUserCodeStore()
    renderWithProviders(store, { authed: true })

    await act(async () => {
      store.setActiveUserCode('ABC-123')
      await Promise.resolve()
    })
    expect(screen.getByTestId('dialog')).toBeDefined()

    // Form's mutation resolves; modal must close *now* — even though
    // the host hasn't yet pushed the new head and the store still
    // reports 'ABC-123' as active.
    await act(async () => {
      lastFormDone?.()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  test('re-opens the popup against a genuinely new head', async () => {
    const store = makeActiveDeviceUserCodeStore()
    renderWithProviders(store, { authed: true })

    await act(async () => {
      store.setActiveUserCode('ABC-123')
      await Promise.resolve()
    })
    await act(async () => {
      lastFormDone?.()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()

    // The host pushes the next pending head — modal reopens against it.
    await act(async () => {
      store.setActiveUserCode('XYZ-789')
      await Promise.resolve()
    })
    const dialog = screen.getByTestId('dialog')
    expect(dialog).toBeDefined()
    expect(screen.getByTestId('form').dataset['userCode']).toBe('XYZ-789')
  })
})
