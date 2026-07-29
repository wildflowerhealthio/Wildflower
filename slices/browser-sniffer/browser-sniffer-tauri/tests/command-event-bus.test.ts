import type { TauriEventApi } from 'effect-messaging-tauri'

import { describe, expect, test, vi } from 'vite-plus/test'

import { DATA_PLANE_EMIT_COMMAND, makeCommandEmitEventBus } from '../src/command-event-bus.ts'
import { BRIDGE_EVENT } from '../src/install-sniffer.ts'

/** An observable `listen` standing in for the `__nativeWebviewReceive` registry. */
const fakeListen = (): {
  readonly listen: TauriEventApi['listen'] & ReturnType<typeof vi.fn>
} => {
  const listen = vi.fn(() => Promise.resolve(() => {}))
  return { listen }
}

describe('makeCommandEmitEventBus — outbound (emit)', () => {
  test('routes a BRIDGE_EVENT emit through the gated command', async () => {
    const { listen } = fakeListen()
    const invoke = vi.fn(() => Promise.resolve())

    const commandBus = makeCommandEmitEventBus(listen, invoke)
    const payload = { _tag: 'ResponseData', id: 'r1', data: 'AA==' }
    await expect(commandBus.emit(BRIDGE_EVENT, payload)).resolves.toBeUndefined()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(DATA_PLANE_EMIT_COMMAND, { payload })
  })

  test('drops a non-BRIDGE_EVENT emit without invoking any transport', async () => {
    const { listen } = fakeListen()
    const invoke = vi.fn(() => Promise.resolve())

    const commandBus = makeCommandEmitEventBus(listen, invoke)
    await expect(commandBus.emit('some-other-event', { _tag: 'X' })).resolves.toBeUndefined()

    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('makeCommandEmitEventBus — inbound (listen)', () => {
  test('delegates listen to the supplied receiver and returns its unlisten', async () => {
    const { listen } = fakeListen()
    const unlisten = vi.fn()
    listen.mockReturnValueOnce(Promise.resolve(unlisten))
    const invoke = vi.fn(() => Promise.resolve())
    const handler = vi.fn()

    const commandBus = makeCommandEmitEventBus(listen, invoke)
    await expect(commandBus.listen(BRIDGE_EVENT, handler)).resolves.toBe(unlisten)

    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen).toHaveBeenCalledWith(BRIDGE_EVENT, handler)
    expect(invoke).not.toHaveBeenCalled()
  })
})
