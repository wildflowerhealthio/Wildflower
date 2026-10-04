import type { ServerServiceStatus } from 'background-server-service-core'
import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { makeServerServiceStatusStore } from './server-service-status-store.ts'
import { makeBackgroundServerServiceWebHandlers } from './web-bridge.ts'

const STOPPED: ServerServiceStatus = {
  _tag: 'ServerServiceStatus',
  state: 'stopped',
  stopReason: 'userStop',
  lastError: null,
  notifications: 'granted',
}

describe('makeBackgroundServerServiceWebHandlers', () => {
  it('should replace the store’s snapshot with each status the host sends', () => {
    // Arrange
    const store = makeServerServiceStatusStore()
    const handlers = makeBackgroundServerServiceWebHandlers(store.setStatus)
    const running: ServerServiceStatus = { ...STOPPED, state: 'running', stopReason: null }

    // Act / Assert
    expect(Effect.runSync(store.subscribable.get)).toBeNull()
    Effect.runSync(handlers.ServerServiceStatus(STOPPED))
    expect(Effect.runSync(store.subscribable.get)).toEqual(STOPPED)
    Effect.runSync(handlers.ServerServiceStatus(running))
    expect(Effect.runSync(store.subscribable.get)).toEqual(running)
  })
})
