import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Effect } from 'effect'
import type { JSX, ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { ActiveDeviceRequestProvider } from './active-device-request-provider.tsx'
import { makeActiveDeviceRequestStore } from './active-device-request-store.ts'
import { useActiveDeviceRequest } from './use-active-device-request.ts'

afterEach(cleanup)

describe('makeActiveDeviceRequestStore', () => {
  test('seeds null and reflects writes through the subscribable', () => {
    const store = makeActiveDeviceRequestStore()
    expect(Effect.runSync(store.subscribable.get)).toBeNull()

    store.setActiveUserCode('ABCD-1234')
    expect(Effect.runSync(store.subscribable.get)).toBe('ABCD-1234')

    store.setActiveUserCode(null)
    expect(Effect.runSync(store.subscribable.get)).toBeNull()
  })
})

describe('useActiveDeviceRequest', () => {
  test('throws when rendered without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => renderHook(() => useActiveDeviceRequest())).toThrow(
        /ActiveDeviceRequestContext must be used inside/
      )
    } finally {
      spy.mockRestore()
    }
  })

  test('returns the current head and re-renders when it changes', async () => {
    const store = makeActiveDeviceRequestStore()
    const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
      <ActiveDeviceRequestProvider store={store}>{children}</ActiveDeviceRequestProvider>
    )
    const { result } = renderHook(() => useActiveDeviceRequest(), { wrapper })
    expect(result.current).toBeNull()

    act(() => {
      store.setActiveUserCode('ABCD-1234')
    })
    await waitFor(() => {
      expect(result.current).toBe('ABCD-1234')
    })

    act(() => {
      store.setActiveUserCode(null)
    })
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })
})
