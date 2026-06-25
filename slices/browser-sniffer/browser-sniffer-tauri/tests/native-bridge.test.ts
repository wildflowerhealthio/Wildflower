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

/**
 * Invoke the installed native receiver global, re-reading it through a fresh
 * `globalThis` view each call. Going through a fresh expression (not the
 * module-scope `globals` binding) keeps an in-body `delete globals.__nativeWebviewReceive`
 * from narrowing the call target to `undefined` — the receiver is reinstalled by
 * a later `makeNativeBridgeEventBus()` that TS can't see into.
 */
const fireReceive = (json: string): void => {
  ;(globalThis as BridgeGlobals).__nativeWebviewReceive?.(json)
}

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

    fireReceive(JSON.stringify({ event: 'bridge', payload: { _tag: 'Click', x: 1, y: 2 } }))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ payload: { _tag: 'Click', x: 1, y: 2 } })
  })

  test('does not deliver envelopes for a different event name', () => {
    const bus = makeNativeBridgeEventBus()
    const handler = vi.fn()
    void bus.listen('bridge', handler)

    fireReceive(JSON.stringify({ event: 'other', payload: {} }))

    expect(handler).not.toHaveBeenCalled()
  })

  test('unlisten stops further delivery', async () => {
    const bus = makeNativeBridgeEventBus()
    const handler = vi.fn()
    const unlisten = await bus.listen('bridge', handler)

    unlisten()
    fireReceive(JSON.stringify({ event: 'bridge', payload: {} }))

    expect(handler).not.toHaveBeenCalled()
  })

  test('ignores malformed inbound JSON without throwing', () => {
    const bus = makeNativeBridgeEventBus()
    const handler = vi.fn()
    void bus.listen('bridge', handler)

    expect(() => fireReceive('not-json')).not.toThrow()
    expect(() => fireReceive('{"no":"event"}')).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('makeNativeBridgeEventBus — singleton registry', () => {
  test('two buses in the same context share one receiver registry', () => {
    // A single native `__nativeWebviewReceive` global dispatches to one
    // module-scope registry, so a second construction must NOT orphan the
    // first's listener — both see the inbound envelope.
    globals.nativeWebview = { postMessage: () => {} }
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    void makeNativeBridgeEventBus().listen('bridge', firstHandler)
    void makeNativeBridgeEventBus().listen('bridge', secondHandler)

    fireReceive(JSON.stringify({ event: 'bridge', payload: { _tag: 'PageLoaded' } }))

    expect(firstHandler).toHaveBeenCalledTimes(1)
    expect(secondHandler).toHaveBeenCalledTimes(1)
  })

  test('reinstalling the receiver (global deleted) clears stale listeners', () => {
    const stale = vi.fn()
    void makeNativeBridgeEventBus().listen('bridge', stale)

    // A fresh JS context (the native plugin never deletes the receiver at
    // runtime, but a test reset / re-injection does): with the global gone the
    // next construction reinstalls the receiver and clears the registry, so the
    // earlier listener can't linger and double-fire.
    delete globals.__nativeWebviewReceive
    const fresh = vi.fn()
    void makeNativeBridgeEventBus().listen('bridge', fresh)

    fireReceive(JSON.stringify({ event: 'bridge', payload: {} }))

    expect(stale).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
  })
})

describe('makeNativeBridgeEventBus — round trip', () => {
  test('an emitted payload survives the envelope and routes back unchanged', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const { posts, postMessage } = capturePosts()
        globals.webkit = { messageHandlers: { nativeWebview: { postMessage } } }

        // Reset the shared singleton receiver each iteration so the prior run's
        // listener is cleared on this construction (see `installReceiverIfMissing`)
        // rather than accumulating in the module-scope registry across runs.
        delete globals.__nativeWebviewReceive
        const bus = makeNativeBridgeEventBus()
        const received: unknown[] = []
        void bus.listen('bridge', (event) => received.push(event.payload))
        void bus.emit('bridge', payload)

        // Echo the exact wire bytes the page posted back through the inbound
        // receiver: the host re-broadcasts on the same channel.
        fireReceive(posts.at(-1) ?? '')

        expect(received).toHaveLength(1)
        // Compare JSON-encoded to sidestep -0/key-order edge cases.
        expect(JSON.stringify(received[0])).toEqual(JSON.stringify(payload))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
