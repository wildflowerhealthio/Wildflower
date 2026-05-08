import { render } from '@testing-library/react'
import { Schema } from 'effect'
import { InteropNativeToWeb, InteropWebToNative, NativeBackRequested } from 'interop-core'
import { type JSX, useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { makeWebMessageHandler } from '../src/message-handler.ts'
import { createNativeBackBridge } from '../src/native-back-bridge.tsx'

const dispatchPostMessage = (raw: string): void => {
  window.dispatchEvent(
    new MessageEvent('message', { data: raw, origin: window.location.origin, source: window })
  )
}

describe('createNativeBackBridge', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  test('queues NativeBackRequested events received before bind() and flushes them once bound', () => {
    const bridge = createNativeBackBridge()
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    bridge.subscribe(handler)

    // Two events arrive while no navigate is bound — they queue.
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))

    let calls = 0
    const unbind = bridge.bind(() => {
      calls += 1
    })
    expect(calls).toBe(2)

    // Subsequent events fire live.
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    expect(calls).toBe(3)

    unbind()
    handler.dispose()
  })

  test('after unbind, events queue again and flush on next bind', () => {
    const bridge = createNativeBackBridge()
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    bridge.subscribe(handler)

    let live = 0
    const unbind = bridge.bind(() => {
      live += 1
    })
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    expect(live).toBe(1)

    unbind()
    // Now unbound — events queue.
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    expect(live).toBe(1)

    let next = 0
    bridge.bind(() => {
      next += 1
    })
    expect(next).toBe(1)

    handler.dispose()
  })

  test('a stale unbind does not detach a replacement bind', () => {
    const bridge = createNativeBackBridge()
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    bridge.subscribe(handler)

    let first = 0
    let second = 0
    const unbindFirst = bridge.bind(() => {
      first += 1
    })
    bridge.bind(() => {
      second += 1
    })
    unbindFirst()
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    expect(first).toBe(0)
    expect(second).toBe(1)

    handler.dispose()
  })
})

describe('<NativeBackBinder>', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  test('routes a live NativeBackRequested through the bound navigate', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    const bridge = createNativeBackBridge()
    bridge.subscribe(handler)

    let backCalls = 0
    function BindBack(): JSX.Element | null {
      const navigate = useNavigate()
      useEffect(
        () =>
          bridge.bind(() => {
            backCalls += 1
            void navigate(-1)
          }),
        [navigate]
      )
      return null
    }

    render(
      <MemoryRouter initialEntries={['/a', '/b']} initialIndex={1}>
        <BindBack />
      </MemoryRouter>
    )

    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    expect(backCalls).toBe(1)

    handler.dispose()
  })

  test('flushes pre-mount queued events when mounted', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    const bridge = createNativeBackBridge()
    bridge.subscribe(handler)

    // Two events arrive before mount.
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))

    let backCalls = 0
    function CountBackBinder(): JSX.Element | null {
      const navigate = useNavigate()
      useEffect(
        () =>
          bridge.bind(() => {
            backCalls += 1
            void navigate(-1)
          }),
        [navigate]
      )
      return null
    }

    render(
      <MemoryRouter initialEntries={['/x', '/y', '/z']} initialIndex={2}>
        <CountBackBinder />
      </MemoryRouter>
    )

    expect(backCalls).toBe(2)
    handler.dispose()
  })
})
