import type { TauriEventApi } from 'effect-messaging-tauri'

import { describe, expect, test, vi } from 'vite-plus/test'

import { DATA_PLANE_EMIT_COMMAND, makeCommandEmitEventBus } from '../src/command-event-bus.ts'
import { BRIDGE_EVENT } from '../src/install-sniffer.ts'

/** A `TauriEventApi` whose `listen` is observable and `emit` would flag misuse. */
const fakeEventBus = (): {
  readonly bus: TauriEventApi
  readonly listen: ReturnType<typeof vi.fn>
  readonly emit: ReturnType<typeof vi.fn>
} => {
  const listen = vi.fn(() => Promise.resolve(() => {}))
  const emit = vi.fn(() => Promise.resolve())
  return { bus: { emit, listen }, listen, emit }
}

describe('makeCommandEmitEventBus — outbound (emit)', () => {
  test('routes a BRIDGE_EVENT emit through the gated command, never the bus', async () => {
    const { bus, emit } = fakeEventBus()
    const invoke = vi.fn(() => Promise.resolve())

    const commandBus = makeCommandEmitEventBus(bus, invoke)
    const payload = { _tag: 'ResponseData', id: 'r1', data: 'AA==' }
    await expect(commandBus.emit(BRIDGE_EVENT, payload)).resolves.toBeUndefined()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(DATA_PLANE_EMIT_COMMAND, { payload })
    // The whole point of the split: the page never reaches `event.emit`.
    expect(emit).not.toHaveBeenCalled()
  })

  test('drops a non-BRIDGE_EVENT emit without invoking any transport', async () => {
    const { bus } = fakeEventBus()
    const invoke = vi.fn(() => Promise.resolve())

    const commandBus = makeCommandEmitEventBus(bus, invoke)
    await expect(commandBus.emit('some-other-event', { _tag: 'X' })).resolves.toBeUndefined()

    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('makeCommandEmitEventBus — inbound (listen)', () => {
  test('delegates listen to the underlying event bus and returns its unlisten', async () => {
    const { bus, listen } = fakeEventBus()
    const unlisten = vi.fn()
    listen.mockReturnValueOnce(Promise.resolve(unlisten))
    const invoke = vi.fn(() => Promise.resolve())
    const handler = vi.fn()

    const commandBus = makeCommandEmitEventBus(bus, invoke)
    await expect(commandBus.listen(BRIDGE_EVENT, handler)).resolves.toBe(unlisten)

    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen).toHaveBeenCalledWith(BRIDGE_EVENT, handler)
    expect(invoke).not.toHaveBeenCalled()
  })
})
