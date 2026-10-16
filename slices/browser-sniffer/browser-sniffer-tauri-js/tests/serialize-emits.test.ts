import type { TauriEventApi } from '@wildflowerhealthio/effect-messaging-tauri-js'
import { describe, expect, it, vi } from 'vite-plus/test'

import { BRIDGE_EVENT } from '../src/install-sniffer.ts'
import { makeSerializedEventBus } from '../src/serialize-emits.ts'

interface Emission {
  readonly event: string
  readonly payload: unknown
}

/**
 * Build a fake {@link TauriEventApi} that records every emit and lets
 * tests register/fire listeners. Test cases construct one of these per
 * scenario so emission histories never cross test boundaries.
 */
const makeFakeBus = (): {
  emissions: Emission[]
  listeners: Map<string, (event: { readonly payload: unknown }) => void>
  bus: TauriEventApi
} => {
  const emissions: Emission[] = []
  const listeners = new Map<string, (event: { readonly payload: unknown }) => void>()
  const bus: TauriEventApi = {
    emit: async (event, payload): Promise<void> => {
      emissions.push({ event, payload })
    },
    listen: async (event, handler): Promise<() => void> => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }
  return { emissions, listeners, bus }
}

/**
 * The wrapper serializes outbound emits through a Promise chain, so a
 * single `await wrapped.emit(...)` resolves to the chain head after the
 * current emit completes. Tests that issue multiple emits and inspect
 * the recorded emissions should drain the microtask queue first so
 * earlier chained emits have landed.
 */
const flushChain = async (): Promise<void> => {
  // oxlint-disable-next-line eslint/no-await-in-loop
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('makeSerializedEventBus', () => {
  describe('pass-through', () => {
    it('forwards emits unchanged on any event name', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeSerializedEventBus(bus)

      const finished = { _tag: 'ResponseFinished', id: 'r1' }
      await wrapped.emit(BRIDGE_EVENT, finished)
      await wrapped.emit('tauri://updater', { something: 'else' })

      expect(emissions).toEqual([
        { event: BRIDGE_EVENT, payload: finished },
        { event: 'tauri://updater', payload: { something: 'else' } },
      ])
    })

    it('forwards listen() through to the underlying bus', async () => {
      const { listeners, bus } = makeFakeBus()
      const wrapped = makeSerializedEventBus(bus)
      const seen: unknown[] = []

      const unlisten = await wrapped.listen(BRIDGE_EVENT, ({ payload }) => {
        seen.push(payload)
      })

      const handler = listeners.get(BRIDGE_EVENT)
      expect(handler).toBeDefined()
      handler?.({
        payload: { _tag: 'PageAction', action: { kind: 'Click', querySelector: '#btn' } },
      })
      expect(seen).toEqual([
        { _tag: 'PageAction', action: { kind: 'Click', querySelector: '#btn' } },
      ])

      unlisten()
      expect(listeners.has(BRIDGE_EVENT)).toBe(false)
    })
  })

  describe('emit-chain FIFO', () => {
    it('serializes a burst of emits — only one bus.emit is in flight at a time', async () => {
      // Each `bus.emit` lands a `{ resolve, emission }` record in
      // `pendingEmits`. With the chain, only one record can be added
      // between resolutions (the chain blocks the next `bus.emit` until
      // the current one resolves). Without the chain, all three
      // `bus.emit` calls would fire during the first microtask burst,
      // populating the array up front — caught by the per-step "length
      // should be N" assertion.
      const emissions: Emission[] = []
      const pendingEmits: { resolve: () => void; emission: Emission }[] = []
      const bus: TauriEventApi = {
        emit: (event, payload) =>
          new Promise<void>((resolve) => {
            pendingEmits.push({ resolve, emission: { event, payload } })
          }),
        listen: async () => () => {},
      }
      const wrapped = makeSerializedEventBus(bus)

      // Three emits issued back-to-back synchronously, fire-and-forget.
      const a = { _tag: 'ResponseStart', id: 'a', url: 'https://x/a', status: 200 }
      const b = { _tag: 'ResponseData', id: 'a', data: 'aaaa' }
      const c = { _tag: 'ResponseFinished', id: 'a' }
      void wrapped.emit(BRIDGE_EVENT, a)
      void wrapped.emit(BRIDGE_EVENT, b)
      void wrapped.emit(BRIDGE_EVENT, c)

      // Drain microtasks until the next `bus.emit` has been recorded.
      // The budget (32) is well beyond the three-or-so microtask cycles
      // each chain step needs (then-result settle → catch pass-through
      // → next then-handler queue). Early-returns on success so the
      // loop terminates as soon as the queue grows.
      const drainUntilQueueLength = async (target: number): Promise<void> => {
        for (let j = 0; j < 32; j += 1) {
          if (pendingEmits.length >= target) return
          // oxlint-disable-next-line eslint/no-await-in-loop -- intentional sequencing of microtask cycles
          await Promise.resolve()
        }
      }

      for (let i = 0; i < 3; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- intentional sequencing of chain steps
        await drainUntilQueueLength(i + 1)
        expect(
          pendingEmits.length,
          `bus.emit ${String(i + 1)} should be in flight by iteration ${String(i)}`
        ).toBe(i + 1)
        const inflight = pendingEmits[i]
        if (inflight === undefined) break
        emissions.push(inflight.emission)
        inflight.resolve()
      }

      expect(emissions).toEqual([
        { event: BRIDGE_EVENT, payload: a },
        { event: BRIDGE_EVENT, payload: b },
        { event: BRIDGE_EVENT, payload: c },
      ])
    })
  })

  describe('dropped emit surfacing', () => {
    it('reports a rejected emit via console.error and keeps the chain alive', async () => {
      // The wrapper captures console.error at construction time; spy before
      // constructing so the captured reference is the spy. A rejected emit
      // must be surfaced (not swallowed) and must not poison the chain for
      // later messages.
      const spy = vi.spyOn(globalThis.console, 'error').mockImplementation(() => {})
      try {
        let attempts = 0
        const bus: TauriEventApi = {
          emit: async (): Promise<void> => {
            attempts += 1
            throw new Error('ipc down')
          },
          listen: async () => () => {},
        }
        const wrapped = makeSerializedEventBus(bus)

        await wrapped.emit(BRIDGE_EVENT, { _tag: 'ResponseData', id: 'r1', data: 'AAAA' })
        await wrapped.emit(BRIDGE_EVENT, { _tag: 'ResponseData', id: 'r1', data: 'BBBB' })
        await flushChain()

        // Both emits reached the bus (the first rejection did not poison
        // the chain) and both failures were reported.
        expect(attempts).toBe(2)
        expect(spy).toHaveBeenCalledTimes(2)
        expect(String(spy.mock.calls[0]?.[0])).toContain('bridge emit dropped')
      } finally {
        spy.mockRestore()
      }
    })
  })
})
