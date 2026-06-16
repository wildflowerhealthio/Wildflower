import { act, cleanup, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { ActiveDeviceUserCodeProvider } from './provider.tsx'
import { makeActiveDeviceUserCodeStore } from './store.ts'
import { useActiveDeviceUserCode } from './use-active-device-user-code.ts'

const RenderUserCode = (): JSX.Element => {
  const userCode = useActiveDeviceUserCode()
  return <div data-testid="user-code">{userCode ?? '(null)'}</div>
}

describe('ActiveDeviceUserCodeStore + useActiveDeviceUserCode', () => {
  afterEach(() => {
    cleanup()
  })

  test('seeds null and re-renders on setActiveUserCode', async () => {
    const store = makeActiveDeviceUserCodeStore()
    render(
      <ActiveDeviceUserCodeProvider store={store}>
        <RenderUserCode />
      </ActiveDeviceUserCodeProvider>
    )

    expect(screen.getByTestId('user-code').textContent).toBe('(null)')

    await act(async () => {
      store.setActiveUserCode('ABC-123')
      // Allow the SubscriptionRef.changes stream's forked fiber to
      // notify React.
      await Promise.resolve()
    })

    expect(screen.getByTestId('user-code').textContent).toBe('ABC-123')

    await act(async () => {
      store.setActiveUserCode(null)
      await Promise.resolve()
    })

    expect(screen.getByTestId('user-code').textContent).toBe('(null)')
  })

  test('useActiveDeviceUserCode throws when used without a provider', () => {
    // React swallows render errors into the console; suppress to keep
    // the harness output clean while still surfacing the thrown error
    // through the testing-library boundary.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<RenderUserCode />)).toThrow(/ActiveDeviceUserCodeProvider/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
