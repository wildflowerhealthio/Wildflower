import { act, cleanup, render, screen } from '@testing-library/react'
import type { PendingConsentHead } from 'gatekeeper-core/bridge'
import { useEffect, type JSX, type ReactNode } from 'react'
import { AuthStateProvider, HostAuthed } from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  ActivePendingConsentProvider,
  makeActivePendingConsentStore,
} from '../../active-pending-consent/index.ts'
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

// Replace each suspense-fetching consent body with a marker that records the key
// it was rendered with — pins that the modal host drives the form's identity off
// the active head (and not, say, a stale closure) *and* that it picked the form
// matching the head's `kind`. A mount-only effect appends to `formMounts` so a
// test can tell a fresh *mount* (new request ⇒ keyed remount ⇒ fresh seeded
// state) apart from a mere prop re-render.
let lastFormDone: (() => void) | null = null
const formMounts: string[] = []

vi.mock('./device-consent-form.tsx', () => ({
  DeviceConsentForm: ({
    consent,
    onDone,
  }: {
    readonly consent: { readonly userCode: string }
    readonly onDone: () => void
  }): JSX.Element => {
    lastFormDone = onDone
    useEffect(() => {
      formMounts.push(`device:${consent.userCode}`)
      // Mount-only by design: firing once per mount is what tells a keyed remount
      // (a new request) apart from a prop re-render of the same instance.
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above
    }, [])
    return <div data-testid="form" data-kind="device" data-key={consent.userCode} />
  },
}))

vi.mock('../oauth-consent/oauth-consent-form.tsx', () => ({
  OAuthConsentForm: ({
    consent,
    onDone,
  }: {
    readonly consent: { readonly id: string }
    readonly onDone: () => void
  }): JSX.Element => {
    lastFormDone = onDone
    useEffect(() => {
      formMounts.push(`oauth:${consent.id}`)
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-only, as above
    }, [])
    return <div data-testid="form" data-kind="oauth" data-key={consent.id} />
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
  useOAuthConsentQuery: (id: string) => ({
    data: {
      id,
      clientId: 'client-id',
      clientName: 'Client',
      scopes: ['openid'],
      redirectUri: 'https://app.example/cb',
      preApprovedScopes: [],
      patient: null,
      registration: { status: 'registered' },
    },
  }),
}))

import { PendingConsentModalHost } from './pending-consent-modal-host.tsx'

const deviceHead = (userCode: string): PendingConsentHead => ({ kind: 'device', userCode })
const oauthHead = (id: string): PendingConsentHead => ({ kind: 'oauth', id })

const renderWithProviders = (
  consentStore: ReturnType<typeof makeActivePendingConsentStore>,
  options: { readonly authed?: boolean } = {}
): ReturnType<typeof makeEmbeddedAuthStateStore> => {
  const tokenStore = makeEmbeddedAuthStateStore()
  if (options.authed === true) {
    tokenStore.setAuthState(HostAuthed())
  }
  render(
    <AuthStateProvider store={tokenStore}>
      <ActivePendingConsentProvider store={consentStore}>
        <PendingConsentModalHost />
      </ActivePendingConsentProvider>
    </AuthStateProvider>
  )
  return tokenStore
}

/** Push `head` onto the store and let the subscription notification land. */
const publish = async (
  store: ReturnType<typeof makeActivePendingConsentStore>,
  head: PendingConsentHead | null
): Promise<void> => {
  await act(async () => {
    store.setActiveHead(head)
    await Promise.resolve()
  })
}

describe('PendingConsentModalHost', () => {
  beforeEach(() => {
    lastFormDone = null
    lastDialogClose = null
    formMounts.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  test('renders nothing while there is no auth token (pre-auth window)', async () => {
    const store = makeActivePendingConsentStore()
    renderWithProviders(store)

    // Even when a consent event somehow arrives before auth, the
    // modal stays inert — no tokenless fetch.
    await publish(store, deviceHead('ABC-123'))

    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  test('renders nothing while the active head is null', () => {
    const store = makeActivePendingConsentStore()
    renderWithProviders(store, { authed: true })

    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  // The head's `kind` picks both the form and the dialog title. Getting this
  // wrong would fetch an authorization-request id from the device endpoint (or
  // vice versa) — a 404 behind the popup rather than a consent prompt.
  test.each([
    {
      label: 'a device head',
      head: deviceHead('ABC-123'),
      kind: 'device',
      key: 'ABC-123',
      title: 'Device Authorization',
    },
    {
      label: 'an oauth head',
      head: oauthHead('req-1'),
      kind: 'oauth',
      key: 'req-1',
      title: 'Authorization Request',
    },
  ])(
    'opens a dismissable dialog with the matching form for $label',
    async ({ head, kind, key, title }) => {
      const store = makeActivePendingConsentStore()
      renderWithProviders(store, { authed: true })

      await publish(store, head)

      const dialog = screen.getByTestId('dialog')
      // Dismissable: the × / ESC closes without deciding (the request stays
      // pending, still answerable from its standalone surface).
      expect(dialog.dataset['dismissable']).toBe('true')
      expect(dialog.dataset['title']).toBe(title)
      const form = screen.getByTestId('form')
      expect(form.dataset['kind']).toBe(kind)
      expect(form.dataset['key']).toBe(key)
    }
  )

  test('remounts the form when the active head changes (no stale per-request state)', async () => {
    // The Dialog stays mounted while the head advances between requests, and the
    // form seeds `draft`/`name`/`denied` from `consent` via mount-only `useState`
    // initializers. The `key` on the form must remount it per request,
    // or the previous request's scope draft / device name would leak onto the new
    // head — approving the wrong grant. A fresh mount per head proves it.
    const store = makeActivePendingConsentStore()
    renderWithProviders(store, { authed: true })

    await publish(store, deviceHead('ABC-123'))
    await publish(store, deviceHead('XYZ-789'))

    // Each head produced its own mount — not one reused instance carrying the
    // first request's seeded state into the second.
    expect(formMounts).toEqual(['device:ABC-123', 'device:XYZ-789'])
    expect(screen.getByTestId('form').dataset['key']).toBe('XYZ-789')
  })

  test('remounts across a flow change, so a device draft never lands on a code request', async () => {
    const store = makeActivePendingConsentStore()
    renderWithProviders(store, { authed: true })

    await publish(store, deviceHead('ABC-123'))
    await publish(store, oauthHead('req-1'))

    expect(formMounts).toEqual(['device:ABC-123', 'oauth:req-1'])
    expect(screen.getByTestId('form').dataset['kind']).toBe('oauth')
  })

  test('a dismissal closes the popup without deciding and it stays closed for that head', async () => {
    const store = makeActivePendingConsentStore()
    renderWithProviders(store, { authed: true })

    await publish(store, oauthHead('req-1'))
    expect(screen.getByTestId('dialog')).toBeDefined()

    // The Dialog's onClose (× / ESC / backdrop) marks the head handled — the
    // popup closes with no approve/deny sent, and does not re-open while the
    // host still reports the same active head.
    await act(async () => {
      lastDialogClose?.()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  test('local handledKey closes the popup immediately on form.onDone, before the host clears', async () => {
    const store = makeActivePendingConsentStore()
    renderWithProviders(store, { authed: true })

    await publish(store, oauthHead('req-1'))
    expect(screen.getByTestId('dialog')).toBeDefined()

    // Form's mutation resolves; modal must close *now* — even though
    // the host hasn't yet pushed the new head and the store still
    // reports 'req-1' as active.
    await act(async () => {
      lastFormDone?.()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  test('re-opens the popup against a genuinely new head', async () => {
    const store = makeActivePendingConsentStore()
    renderWithProviders(store, { authed: true })

    await publish(store, deviceHead('ABC-123'))
    await act(async () => {
      lastFormDone?.()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()

    // The host pushes the next pending head — modal reopens against it.
    await publish(store, oauthHead('req-1'))
    const dialog = screen.getByTestId('dialog')
    expect(dialog).toBeDefined()
    expect(screen.getByTestId('form').dataset['key']).toBe('req-1')
  })

  // A device `userCode` and an authorization-request `id` share one string
  // space. The handled-marker is variant-prefixed so a code request whose id
  // happens to equal a just-handled userCode still opens the popup.
  test('a new head whose key collides with a handled one still opens', async () => {
    const store = makeActivePendingConsentStore()
    renderWithProviders(store, { authed: true })

    await publish(store, deviceHead('ABC-123'))
    await act(async () => {
      lastFormDone?.()
    })
    expect(screen.queryByTestId('dialog')).toBeNull()

    await publish(store, oauthHead('ABC-123'))
    expect(screen.getByTestId('dialog')).toBeDefined()
    expect(screen.getByTestId('form').dataset['kind']).toBe('oauth')
  })
})
