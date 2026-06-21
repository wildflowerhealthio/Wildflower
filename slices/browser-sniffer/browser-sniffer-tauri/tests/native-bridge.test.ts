// oxlint-disable no-underscore-dangle -- `__nativeWebviewReceive` is the exact global the native plugin calls; the test drives it directly.

import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { makeNativeBridgeEventBus } from '../src/native-bridge.ts'

/**
 * Typed view of the globals the native bridge reads/writes. Tests own these
 * slots, setting them per case and clearing them after.
 */
type BridgeGlobals = typeof globalThis & {
  webkit?: { messageHandlers?: { nativeWebview?: { postMessage: (message: string) => void } } }
  nativeWebview?: { postMessage: (message: string) => void }
  __nativeWebviewReceive?: (json: string) => void
}

const globals = globalThis as BridgeGlobals

/** A `postMessage` capture: the install fn plus the typed list of strings it received. */
const capturePosts = (): {
  readonly posts: string[]
  readonly postMessage: (message: string) => void
} => {
  const posts: string[] = []
  return { posts, postMessage: (message) => posts.push(message) }
}

const clearGlobals = (): void => {
  delete globals.webkit
  delete globals.nativeWebview
  delete globals.__nativeWebviewReceive
}

beforeEach(clearGlobals)
afterEach(clearGlobals)

describe('makeNativeBridgeEventBus — outbound (emit)', () => {
  test('posts a JSON envelope { event, payload } to the iOS handler', () => {
    const { posts, postMessage } = capturePosts()
    globals.webkit = { messageHandlers: { nativeWebview: { postMessage } } }

    const bus = makeNativeBridgeEventBus()
    void bus.emit('bridge', { _tag: 'PageLoaded', url: 'https://x.test/' })

    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0])).toEqual({
      event: 'bridge',
      payload: { _tag: 'PageLoaded', url: 'https://x.test/' },
    })
  })

  test('posts to the Android handler when webkit is absent', () => {
    const { posts, postMessage } = capturePosts()
    globals.nativeWebview = { postMessage }

    const bus = makeNativeBridgeEventBus()
    void bus.emit('bridge', { _tag: 'SniffingComplete' })

    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0])).toEqual({ event: 'bridge', payload: { _tag: 'SniffingComplete' } })
  })

  test('prefers the iOS handler when both bridges are present', () => {
    const ios = capturePosts()
    const android = capturePosts()
    globals.webkit = { messageHandlers: { nativeWebview: { postMessage: ios.postMessage } } }
    globals.nativeWebview = { postMessage: android.postMessage }

    const bus = makeNativeBridgeEventBus()
    void bus.emit('bridge', { _tag: 'Log' })

    expect(ios.posts).toHaveLength(1)
    expect(android.posts).toHaveLength(0)
  })

  test('is a silent no-op when no native bridge is present', async () => {
    const bus = makeNativeBridgeEventBus()
    await expect(bus.emit('bridge', { _tag: 'Log' })).resolves.toBeUndefined()
  })
})

describe('makeNativeBridgeEventBus — inbound (listen)', () => {
  test('delivers a matching inbound envelope to the listener as { payload }', () => {
    const bus = makeNativeBridgeEventBus()
    const handler = vi.fn()
    void bus.listen('bridge', handler)

    globals.__nativeWebviewReceive?.(
      JSON.stringify({ event: 'bridge', payload: { _tag: 'Click', x: 1, y: 2 } })
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ payload: { _tag: 'Click', x: 1, y: 2 } })
  })

  test('does not deliver envelopes for a different event name', () => {
    const bus = makeNativeBridgeEventBus()
    const handler = vi.fn()
    void bus.listen('bridge', handler)

    globals.__nativeWebviewReceive?.(JSON.stringify({ event: 'other', payload: {} }))

    expect(handler).not.toHaveBeenCalled()
  })

  test('unlisten stops further delivery', async () => {
    const bus = makeNativeBridgeEventBus()
    const handler = vi.fn()
    const unlisten = await bus.listen('bridge', handler)

    unlisten()
    globals.__nativeWebviewReceive?.(JSON.stringify({ event: 'bridge', payload: {} }))

    expect(handler).not.toHaveBeenCalled()
  })

  test('ignores malformed inbound JSON without throwing', () => {
    const bus = makeNativeBridgeEventBus()
    const handler = vi.fn()
    void bus.listen('bridge', handler)

    expect(() => globals.__nativeWebviewReceive?.('not-json')).not.toThrow()
    expect(() => globals.__nativeWebviewReceive?.('{"no":"event"}')).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('makeNativeBridgeEventBus — round trip', () => {
  test('an emitted payload survives the envelope and routes back unchanged', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const { posts, postMessage } = capturePosts()
        globals.webkit = { messageHandlers: { nativeWebview: { postMessage } } }

        const bus = makeNativeBridgeEventBus()
        const received: unknown[] = []
        void bus.listen('bridge', (event) => received.push(event.payload))
        void bus.emit('bridge', payload)

        // Echo the exact wire bytes the page posted back through the inbound
        // receiver: the host re-broadcasts on the same channel.
        globals.__nativeWebviewReceive?.(posts.at(-1) ?? '')

        expect(received).toHaveLength(1)
        // Compare JSON-encoded to sidestep -0/key-order edge cases.
        expect(JSON.stringify(received[0])).toEqual(JSON.stringify(payload))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
