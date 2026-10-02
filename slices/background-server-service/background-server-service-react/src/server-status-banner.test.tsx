import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ServerServiceStatus } from 'background-server-service-core'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ServerServiceTestProviders } from './server-service-test-providers.tsx'
import { ServerStatusBanner } from './server-status-banner.tsx'
import { makeRecordingSender, storeHolding } from './test-support.ts'

const arbitraryStatus = Arbitrary.make(Schema.typeSchema(ServerServiceStatus))

const STOPPED_WITH_BIND_ERROR: ServerServiceStatus = {
  _tag: 'ServerServiceStatus',
  state: 'stopped',
  stopReason: 'platformExpiration',
  lastError: 'failed to bind to 127.0.0.1:8080: Address already in use',
  notifications: 'granted',
}

const renderBanner = (
  status: ServerServiceStatus | null
): ReturnType<typeof makeRecordingSender> &
  ReturnType<typeof render> & { readonly store: ReturnType<typeof storeHolding> } => {
  const store = storeHolding(status)
  const sender = makeRecordingSender()
  const rendered = render(
    <ServerServiceTestProviders store={store} send={sender.send}>
      <ServerStatusBanner />
    </ServerServiceTestProviders>
  )
  return { ...sender, ...rendered, store }
}

afterEach(() => {
  cleanup()
})

describe('ServerStatusBanner', () => {
  it('should render nothing before the first snapshot arrives', () => {
    // Act
    const { container } = renderBanner(null)

    // Assert
    expect(container.innerHTML).toBe('')
  })

  it('should render nothing for any running status', () => {
    fc.assert(
      fc.property(
        arbitraryStatus.map((status) => ({ ...status, state: 'running' as const })),
        (status) => {
          // Act
          const { container, unmount } = renderBanner(status)

          // Assert
          expect(container.innerHTML).toBe('')
          unmount()
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  it('should show a stopped server’s stop reason and error', () => {
    // Act
    renderBanner(STOPPED_WITH_BIND_ERROR)

    // Assert
    expect(screen.getByText('Stopped')).toBeDefined()
    expect(
      screen.getByText("The Wildflower server isn't running. iOS ended the background window.")
    ).toBeDefined()
    expect(screen.getByRole('alert').textContent).toBe(
      'failed to bind to 127.0.0.1:8080: Address already in use'
    )
  })

  it('should show a starting server calmly, without an error or the previous run’s stop reason', () => {
    // Act — a restart's starting run still carries its own `appStop`.
    renderBanner({
      _tag: 'ServerServiceStatus',
      state: 'starting',
      stopReason: 'appStop',
      lastError: null,
      notifications: 'granted',
    })

    // Assert
    expect(screen.getByText('The Wildflower server is starting.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/restart\./i)).toBeNull()
  })

  it('should send RestartServer when Restart is pressed', async () => {
    // Arrange
    const { sent } = renderBanner(STOPPED_WITH_BIND_ERROR)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

    // Assert
    expect(sent).toEqual([{ _tag: 'RestartServer' }])
  })

  it('should disappear when the next snapshot says the server is running', async () => {
    // Arrange
    const { container, store } = renderBanner(STOPPED_WITH_BIND_ERROR)

    // Act
    act(() => {
      store.setStatus({ ...STOPPED_WITH_BIND_ERROR, state: 'running', lastError: null })
    })

    // Assert
    await waitFor(() => {
      expect(container.innerHTML).toBe('')
    })
  })
})
