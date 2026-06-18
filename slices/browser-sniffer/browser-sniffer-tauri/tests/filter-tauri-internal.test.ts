import type { TauriEventApi } from 'effect-messaging-tauri'
import { describe, expect, it } from 'vite-plus/test'

import { makeFilteringEventBus } from '../src/filter-tauri-internal.ts'
import { BRIDGE_EVENT } from '../src/install-sniffer.ts'

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
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

const TAURI_IPC_FALLBACK_LOG = {
  _tag: 'Log',
  level: 'warn',
  payload: ['IPC custom protocol failed: WebKit blocked ipc://localhost'],
}

const FETCH_THREW_LOG = {
  _tag: 'Log',
  level: 'warn',
  payload: ['fetch threw before response: TypeError: Failed to fetch'],
}

describe('makeFilteringEventBus', () => {
  describe('pass-through', () => {
    it('forwards non-BRIDGE_EVENT emits unchanged', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('tauri://updater', { something: 'else' })

      expect(emissions).toEqual([{ event: 'tauri://updater', payload: { something: 'else' } }])
    })

    it('forwards BRIDGE_EVENT emits with non-object payloads unchanged', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, null)
      await wrapped.emit(BRIDGE_EVENT, 'string-payload')

      expect(emissions).toEqual([
        { event: BRIDGE_EVENT, payload: null },
        { event: BRIDGE_EVENT, payload: 'string-payload' },
      ])
    })

    it('forwards BRIDGE_EVENT emits whose payload has no string _tag unchanged', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const noTag = { id: 'r1', url: 'https://example.com' }
      await wrapped.emit(BRIDGE_EVENT, noTag)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: noTag }])
    })

    it('forwards listen() through to the underlying bus', async () => {
      const { listeners, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)
      const seen: unknown[] = []

      const unlisten = await wrapped.listen(BRIDGE_EVENT, ({ payload }) => {
        seen.push(payload)
      })

      const handler = listeners.get(BRIDGE_EVENT)
      expect(handler).toBeDefined()
      handler?.({ payload: { _tag: 'Click', querySelector: '#btn' } })
      expect(seen).toEqual([{ _tag: 'Click', querySelector: '#btn' }])

      unlisten()
      expect(listeners.has(BRIDGE_EVENT)).toBe(false)
    })

    it('forwards SniffingComplete (not a filtered tag)', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, { _tag: 'SniffingComplete' })

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: { _tag: 'SniffingComplete' } }])
    })

    it('forwards non-warn Logs', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const infoLog = { _tag: 'Log', level: 'info', payload: ['IPC custom protocol failed'] }
      await wrapped.emit(BRIDGE_EVENT, infoLog)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: infoLog }])
    })

    it('forwards Logs whose first payload entry does not match a guarded prefix', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const ordinaryWarn = { _tag: 'Log', level: 'warn', payload: ['something else broke'] }
      await wrapped.emit(BRIDGE_EVENT, ordinaryWarn)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: ordinaryWarn }])
    })
  })

  describe('Tauri IPC fallback Log', () => {
    it('drops the warn entirely', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, TAURI_IPC_FALLBACK_LOG)
      await flushChain()

      expect(emissions).toEqual([])
    })

    it('does not affect a following unrelated event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, TAURI_IPC_FALLBACK_LOG)
      const externalStart = {
        _tag: 'ResponseStart',
        id: 'r1',
        url: 'https://api.example.com/things',
        status: 200,
        statusText: 'OK',
        headers: [],
      }
      await wrapped.emit(BRIDGE_EVENT, externalStart)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: externalStart }])
    })
  })

  describe('Tauri-internal ResponseStart gating', () => {
    const internalUrls = [
      'ipc://localhost/something',
      'tauri://localhost/asset',
      'http://ipc.localhost/x',
      'https://ipc.localhost/x',
      'http://tauri.localhost/x',
      'https://tauri.localhost/x',
    ]

    for (const url of internalUrls) {
      it(`drops ResponseStart for ${url}`, async () => {
        const { emissions, bus } = makeFakeBus()
        const wrapped = makeFilteringEventBus(bus)

        await wrapped.emit(BRIDGE_EVENT, {
          _tag: 'ResponseStart',
          id: 'i1',
          url,
          status: 200,
          statusText: 'OK',
          headers: [],
        })
        await flushChain()

        expect(emissions).toEqual([])
      })
    }

    it('forwards ResponseStart for a real external URL', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const start = {
        _tag: 'ResponseStart',
        id: 'r1',
        url: 'https://api.example.com/users',
        status: 200,
        statusText: 'OK',
        headers: [],
      }
      await wrapped.emit(BRIDGE_EVENT, start)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: start }])
    })

    it('drops chunk and terminal events tied to an internal id', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'ResponseStart',
        id: 'i1',
        url: 'ipc://localhost/cmd',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      await wrapped.emit(BRIDGE_EVENT, { _tag: 'ResponseData', id: 'i1', data: 'AAAA' })
      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'RequestError',
        id: 'i1',
        url: 'ipc://localhost/cmd',
        message: 'blocked',
      })
      await flushChain()

      expect(emissions).toEqual([])
    })

    it('forwards events for ids that were never tagged internal', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const chunk = { _tag: 'ResponseData', id: 'r-unknown', data: 'ABCD' }
      await wrapped.emit(BRIDGE_EVENT, chunk)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: chunk }])
    })

    it('releases an internal id on ResponseFinished so future reuse forwards', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'ResponseStart',
        id: 'reused',
        url: 'ipc://localhost/a',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      await wrapped.emit(BRIDGE_EVENT, { _tag: 'ResponseFinished', id: 'reused' })

      const lateChunk = { _tag: 'ResponseData', id: 'reused', data: 'WXYZ' }
      await wrapped.emit(BRIDGE_EVENT, lateChunk)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: lateChunk }])
    })

    it('releases an internal id on RequestError as a terminal event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'ResponseStart',
        id: 'r',
        url: 'tauri://localhost/x',
        status: 0,
        statusText: '',
        headers: [],
      })
      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'RequestError',
        id: 'r',
        url: 'tauri://localhost/x',
        message: 'boom',
      })

      const reuse = { _tag: 'ResponseData', id: 'r', data: 'AA' }
      await wrapped.emit(BRIDGE_EVENT, reuse)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: reuse }])
    })

    it('releases an internal id on Cancelled as a terminal event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'ResponseStart',
        id: 'r',
        url: 'https://ipc.localhost/y',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      await wrapped.emit(BRIDGE_EVENT, { _tag: 'Cancelled', id: 'r' })

      const reuse = { _tag: 'ResponseData', id: 'r', data: 'AA' }
      await wrapped.emit(BRIDGE_EVENT, reuse)

      expect(emissions).toEqual([{ event: BRIDGE_EVENT, payload: reuse }])
    })

    it('still drops ResponseStart when the id is missing (no crash, just drop)', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'ResponseStart',
        url: 'ipc://localhost/cmd',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      await flushChain()

      expect(emissions).toEqual([])
    })
  })

  describe('sniffer fetch-threw Log buffer', () => {
    it('drops the Log when followed by an internal-URL ResponseStart', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, FETCH_THREW_LOG)
      await wrapped.emit(BRIDGE_EVENT, {
        _tag: 'ResponseStart',
        id: 'i1',
        url: 'ipc://localhost/cmd',
        status: 0,
        statusText: '',
        headers: [],
      })
      await flushChain()

      expect(emissions).toEqual([])
    })

    it('forwards the Log first, then the external ResponseStart', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, FETCH_THREW_LOG)
      const externalStart = {
        _tag: 'ResponseStart',
        id: 'r1',
        url: 'https://api.example.com/x',
        status: 0,
        statusText: '',
        headers: [],
      }
      await wrapped.emit(BRIDGE_EVENT, externalStart)
      await flushChain()

      expect(emissions).toEqual([
        { event: BRIDGE_EVENT, payload: FETCH_THREW_LOG },
        { event: BRIDGE_EVENT, payload: externalStart },
      ])
    })

    it('safety-drains the Log on any non-ResponseStart event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, FETCH_THREW_LOG)
      const cancelled = { _tag: 'Cancelled', id: 'r1' }
      await wrapped.emit(BRIDGE_EVENT, cancelled)
      await flushChain()

      expect(emissions).toEqual([
        { event: BRIDGE_EVENT, payload: FETCH_THREW_LOG },
        { event: BRIDGE_EVENT, payload: cancelled },
      ])
    })

    it('clears the buffer after the first drain (does not double-emit)', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit(BRIDGE_EVENT, FETCH_THREW_LOG)
      const drainEvent = { _tag: 'Cancelled', id: 'r1' }
      await wrapped.emit(BRIDGE_EVENT, drainEvent)

      const otherEvent = { _tag: 'Cancelled', id: 'r2' }
      await wrapped.emit(BRIDGE_EVENT, otherEvent)
      await flushChain()

      expect(emissions).toEqual([
        { event: BRIDGE_EVENT, payload: FETCH_THREW_LOG },
        { event: BRIDGE_EVENT, payload: drainEvent },
        { event: BRIDGE_EVENT, payload: otherEvent },
      ])
    })

    it('overwrites a stale buffered Log with a newer one (last-wins)', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const firstLog = {
        _tag: 'Log',
        level: 'warn',
        payload: ['fetch threw before response: first'],
      }
      const secondLog = {
        _tag: 'Log',
        level: 'warn',
        payload: ['fetch threw before response: second'],
      }
      await wrapped.emit(BRIDGE_EVENT, firstLog)
      await wrapped.emit(BRIDGE_EVENT, secondLog)
      const drain = { _tag: 'Cancelled', id: 'r1' }
      await wrapped.emit(BRIDGE_EVENT, drain)
      await flushChain()

      expect(emissions).toEqual([
        { event: BRIDGE_EVENT, payload: secondLog },
        { event: BRIDGE_EVENT, payload: drain },
      ])
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
      const wrapped = makeFilteringEventBus(bus)

      // Three external-URL emits — all pass the filter and ride the
      // chain. Issued back-to-back synchronously, fire-and-forget.
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
})
