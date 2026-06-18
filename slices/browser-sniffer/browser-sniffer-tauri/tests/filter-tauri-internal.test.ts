import type { TauriEventApi } from 'effect-messaging-tauri'
import { describe, expect, it } from 'vite-plus/test'

import { makeFilteringEventBus } from '../src/filter-tauri-internal.ts'

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
    it('forwards non-bridge emits unchanged', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('tauri://updater', { something: 'else' })

      expect(emissions).toEqual([{ event: 'tauri://updater', payload: { something: 'else' } }])
    })

    it('forwards bridge emits with non-object payloads unchanged', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:Log', null)
      await wrapped.emit('bridge:Log', 'string-payload')

      expect(emissions).toEqual([
        { event: 'bridge:Log', payload: null },
        { event: 'bridge:Log', payload: 'string-payload' },
      ])
    })

    it('forwards listen() through to the underlying bus', async () => {
      const { listeners, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)
      const seen: unknown[] = []

      const unlisten = await wrapped.listen('bridge:Click', ({ payload }) => {
        seen.push(payload)
      })

      const handler = listeners.get('bridge:Click')
      expect(handler).toBeDefined()
      handler?.({ payload: { _tag: 'Click', querySelector: '#btn' } })
      expect(seen).toEqual([{ _tag: 'Click', querySelector: '#btn' }])

      unlisten()
      expect(listeners.has('bridge:Click')).toBe(false)
    })

    it('forwards bridge:SniffingComplete (not a filtered tag)', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:SniffingComplete', { _tag: 'SniffingComplete' })

      expect(emissions).toEqual([
        { event: 'bridge:SniffingComplete', payload: { _tag: 'SniffingComplete' } },
      ])
    })

    it('forwards non-warn Logs', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const infoLog = { _tag: 'Log', level: 'info', payload: ['IPC custom protocol failed'] }
      await wrapped.emit('bridge:Log', infoLog)

      expect(emissions).toEqual([{ event: 'bridge:Log', payload: infoLog }])
    })

    it('forwards Logs whose first payload entry does not match a guarded prefix', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const ordinaryWarn = { _tag: 'Log', level: 'warn', payload: ['something else broke'] }
      await wrapped.emit('bridge:Log', ordinaryWarn)

      expect(emissions).toEqual([{ event: 'bridge:Log', payload: ordinaryWarn }])
    })
  })

  describe('Tauri IPC fallback Log', () => {
    it('drops the warn entirely', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:Log', TAURI_IPC_FALLBACK_LOG)

      expect(emissions).toEqual([])
    })

    it('does not affect a following unrelated event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:Log', TAURI_IPC_FALLBACK_LOG)
      const externalStart = {
        _tag: 'ResponseStart',
        id: 'r1',
        url: 'https://api.example.com/things',
        status: 200,
        statusText: 'OK',
        headers: [],
      }
      await wrapped.emit('bridge:ResponseStart', externalStart)

      expect(emissions).toEqual([{ event: 'bridge:ResponseStart', payload: externalStart }])
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

        await wrapped.emit('bridge:ResponseStart', {
          _tag: 'ResponseStart',
          id: 'i1',
          url,
          status: 200,
          statusText: 'OK',
          headers: [],
        })

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
      await wrapped.emit('bridge:ResponseStart', start)

      expect(emissions).toEqual([{ event: 'bridge:ResponseStart', payload: start }])
    })

    it('drops chunk and terminal events tied to an internal id', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:ResponseStart', {
        _tag: 'ResponseStart',
        id: 'i1',
        url: 'ipc://localhost/cmd',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      await wrapped.emit('bridge:ResponseData', { _tag: 'ResponseData', id: 'i1', data: 'AAAA' })
      await wrapped.emit('bridge:RequestError', {
        _tag: 'RequestError',
        id: 'i1',
        url: 'ipc://localhost/cmd',
        message: 'blocked',
      })

      expect(emissions).toEqual([])
    })

    it('forwards events for ids that were never tagged internal', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      const chunk = { _tag: 'ResponseData', id: 'r-unknown', data: 'ABCD' }
      await wrapped.emit('bridge:ResponseData', chunk)

      expect(emissions).toEqual([{ event: 'bridge:ResponseData', payload: chunk }])
    })

    it('releases an internal id on ResponseFinished so future reuse forwards', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:ResponseStart', {
        _tag: 'ResponseStart',
        id: 'reused',
        url: 'ipc://localhost/a',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      await wrapped.emit('bridge:ResponseFinished', { _tag: 'ResponseFinished', id: 'reused' })

      const lateChunk = { _tag: 'ResponseData', id: 'reused', data: 'WXYZ' }
      await wrapped.emit('bridge:ResponseData', lateChunk)

      expect(emissions).toEqual([{ event: 'bridge:ResponseData', payload: lateChunk }])
    })

    it('releases an internal id on RequestError as a terminal event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:ResponseStart', {
        _tag: 'ResponseStart',
        id: 'r',
        url: 'tauri://localhost/x',
        status: 0,
        statusText: '',
        headers: [],
      })
      await wrapped.emit('bridge:RequestError', {
        _tag: 'RequestError',
        id: 'r',
        url: 'tauri://localhost/x',
        message: 'boom',
      })

      const reuse = { _tag: 'ResponseData', id: 'r', data: 'AA' }
      await wrapped.emit('bridge:ResponseData', reuse)

      expect(emissions).toEqual([{ event: 'bridge:ResponseData', payload: reuse }])
    })

    it('releases an internal id on Cancelled as a terminal event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:ResponseStart', {
        _tag: 'ResponseStart',
        id: 'r',
        url: 'https://ipc.localhost/y',
        status: 200,
        statusText: 'OK',
        headers: [],
      })
      await wrapped.emit('bridge:Cancelled', { _tag: 'Cancelled', id: 'r' })

      const reuse = { _tag: 'ResponseData', id: 'r', data: 'AA' }
      await wrapped.emit('bridge:ResponseData', reuse)

      expect(emissions).toEqual([{ event: 'bridge:ResponseData', payload: reuse }])
    })

    it('still drops ResponseStart when the id is missing (no crash, just drop)', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:ResponseStart', {
        _tag: 'ResponseStart',
        url: 'ipc://localhost/cmd',
        status: 200,
        statusText: 'OK',
        headers: [],
      })

      expect(emissions).toEqual([])
    })
  })

  describe('sniffer fetch-threw Log buffer', () => {
    it('drops the Log when followed by an internal-URL ResponseStart', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:Log', FETCH_THREW_LOG)
      await wrapped.emit('bridge:ResponseStart', {
        _tag: 'ResponseStart',
        id: 'i1',
        url: 'ipc://localhost/cmd',
        status: 0,
        statusText: '',
        headers: [],
      })

      // Both the Log and the ResponseStart are dropped.
      expect(emissions).toEqual([])
    })

    it('forwards the Log first, then the external ResponseStart', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:Log', FETCH_THREW_LOG)
      const externalStart = {
        _tag: 'ResponseStart',
        id: 'r1',
        url: 'https://api.example.com/x',
        status: 0,
        statusText: '',
        headers: [],
      }
      await wrapped.emit('bridge:ResponseStart', externalStart)

      expect(emissions).toEqual([
        { event: 'bridge:Log', payload: FETCH_THREW_LOG },
        { event: 'bridge:ResponseStart', payload: externalStart },
      ])
    })

    it('safety-drains the Log on any non-ResponseStart event', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:Log', FETCH_THREW_LOG)
      const cancelled = { _tag: 'Cancelled', id: 'r1' }
      await wrapped.emit('bridge:Cancelled', cancelled)

      expect(emissions).toEqual([
        { event: 'bridge:Log', payload: FETCH_THREW_LOG },
        { event: 'bridge:Cancelled', payload: cancelled },
      ])
    })

    it('clears the buffer after the first drain (does not double-emit)', async () => {
      const { emissions, bus } = makeFakeBus()
      const wrapped = makeFilteringEventBus(bus)

      await wrapped.emit('bridge:Log', FETCH_THREW_LOG)
      const drainEvent = { _tag: 'Cancelled', id: 'r1' }
      await wrapped.emit('bridge:Cancelled', drainEvent)

      // Second non-Log event arrives; the buffer is already cleared so
      // only this event should be emitted.
      const otherEvent = { _tag: 'Cancelled', id: 'r2' }
      await wrapped.emit('bridge:Cancelled', otherEvent)

      expect(emissions).toEqual([
        { event: 'bridge:Log', payload: FETCH_THREW_LOG },
        { event: 'bridge:Cancelled', payload: drainEvent },
        { event: 'bridge:Cancelled', payload: otherEvent },
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
      await wrapped.emit('bridge:Log', firstLog)
      await wrapped.emit('bridge:Log', secondLog)
      // Force a drain via a non-buffered event.
      const drain = { _tag: 'Cancelled', id: 'r1' }
      await wrapped.emit('bridge:Cancelled', drain)

      // First Log was overwritten; only the second one drains.
      expect(emissions).toEqual([
        { event: 'bridge:Log', payload: secondLog },
        { event: 'bridge:Cancelled', payload: drain },
      ])
    })
  })
})
