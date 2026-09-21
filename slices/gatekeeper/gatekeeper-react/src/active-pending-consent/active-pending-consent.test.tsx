import { act, cleanup, render, screen } from '@testing-library/react'
import type { PendingConsentHead } from 'gatekeeper-core/bridge'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { ActivePendingConsentProvider } from './provider.tsx'
import { makeActivePendingConsentStore } from './store.ts'
import { useActivePendingConsent } from './use-active-pending-consent.ts'

const RenderHead = (): JSX.Element => {
  const head = useActivePendingConsent()
  return <div data-testid="head">{head === null ? '(null)' : JSON.stringify(head)}</div>
}

/**
 * Push `head` onto the store and let the `SubscriptionRef.changes` stream's
 * forked fiber notify React before the caller asserts.
 */
const publish = async (
  store: ReturnType<typeof makeActivePendingConsentStore>,
  head: PendingConsentHead | null
): Promise<void> => {
  await act(async () => {
    store.setActiveHead(head)
    await Promise.resolve()
  })
}

describe('ActivePendingConsentStore + useActivePendingConsent', () => {
  afterEach(() => {
    cleanup()
  })

  // The store is a pass-through for whatever the host pushed, including the
  // `kind` the modal host branches on — a store that flattened the head to a
  // string would send every code request to the device consent endpoint.
  test.each([
    { label: 'a device head', head: { kind: 'device', userCode: 'ABC-123' } as const },
    { label: 'an oauth head', head: { kind: 'oauth', id: 'req-1' } as const },
  ])('seeds null and re-renders on setActiveHead with $label', async ({ head }) => {
    const store = makeActivePendingConsentStore()
    render(
      <ActivePendingConsentProvider store={store}>
        <RenderHead />
      </ActivePendingConsentProvider>
    )

    expect(screen.getByTestId('head').textContent).toBe('(null)')

    await publish(store, head)
    expect(screen.getByTestId('head').textContent).toBe(JSON.stringify(head))

    await publish(store, null)
    expect(screen.getByTestId('head').textContent).toBe('(null)')
  })

  test('advances between heads of different flows', async () => {
    const store = makeActivePendingConsentStore()
    render(
      <ActivePendingConsentProvider store={store}>
        <RenderHead />
      </ActivePendingConsentProvider>
    )

    // Written as explicit sequential steps rather than a loop: each publish
    // must land (and be asserted) before the next, so these can't be collapsed
    // into a parallel `Promise.all`.
    const device: PendingConsentHead = { kind: 'device', userCode: 'ABC-123' }
    const oauth: PendingConsentHead = { kind: 'oauth', id: 'req-1' }

    await publish(store, device)
    expect(screen.getByTestId('head').textContent).toBe(JSON.stringify(device))

    await publish(store, oauth)
    expect(screen.getByTestId('head').textContent).toBe(JSON.stringify(oauth))
  })

  test('useActivePendingConsent throws when used without a provider', () => {
    // React swallows render errors into the console; suppress to keep
    // the harness output clean while still surfacing the thrown error
    // through the testing-library boundary.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<RenderHead />)).toThrow(/ActivePendingConsentContext/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
