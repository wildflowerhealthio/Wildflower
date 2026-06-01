import { Effect, Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'
import { describe, expect, test } from 'vite-plus/test'
import { type BridgeHandlerRecord, makeHandlerCoordinator } from './handler-coordinator.ts'

const A = Bridge.make({
  name: 'A',
  hostToWeb: [['Ping', Schema.parseJson(Schema.TaggedStruct('Ping', {}))]] as const,
  webToHost: [] as const,
})
const B = Bridge.make({
  name: 'B',
  hostToWeb: [['Pong', Schema.parseJson(Schema.TaggedStruct('Pong', {}))]] as const,
  webToHost: [] as const,
})
const bridges = [A, B] as const

const makeRecorder = (): {
  readonly calls: ReadonlyArray<BridgeHandlerRecord>[]
  readonly registerHandlers: (
    handlers: Bridge.HandlersByBridge<typeof bridges, 'HostToWeb'>
  ) => Effect.Effect<void>
} => {
  const calls: ReadonlyArray<BridgeHandlerRecord>[] = []
  return {
    calls,
    registerHandlers: (handlers) =>
      Effect.sync(() => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        calls.push(handlers as unknown as ReadonlyArray<BridgeHandlerRecord>)
      }),
  }
}

describe('makeHandlerCoordinator', () => {
  test('initialHandlers seed boot-stable records; absent bridges are drop-all', () => {
    const seededB: BridgeHandlerRecord = { Pong: () => Effect.void }
    const { initialHandlers } = makeHandlerCoordinator({
      bridges,
      inboundDirection: 'HostToWeb',
      initial: { B: seededB },
    })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const tuple = initialHandlers as unknown as ReadonlyArray<BridgeHandlerRecord>
    // A is unseeded → drop-all over its inbound tags; B keeps its seed.
    expect(typeof tuple[0]?.Ping).toBe('function')
    expect(tuple[1]).toBe(seededB)
  })

  test('register places the record in its bridges-order slot; the other bridge is drop-all', () => {
    const recorder = makeRecorder()
    const coordinator = makeHandlerCoordinator({
      bridges,
      inboundDirection: 'HostToWeb',
      initial: {},
    }).connect(recorder.registerHandlers)
    const recordA: BridgeHandlerRecord = { Ping: () => Effect.void }

    Effect.runSync(coordinator.register('A', recordA))

    expect(recorder.calls).toHaveLength(1)
    const tuple = recorder.calls[0]
    expect(tuple?.[0]).toBe(recordA)
    // B has no registered record → drop-all over its inbound tags.
    expect(typeof tuple?.[1]?.Pong).toBe('function')
  })

  test('unregister is set-if-equal: a stale record does not evict the current one', () => {
    const recorder = makeRecorder()
    const coordinator = makeHandlerCoordinator({
      bridges,
      inboundDirection: 'HostToWeb',
      initial: {},
    }).connect(recorder.registerHandlers)
    const recordA: BridgeHandlerRecord = { Ping: () => Effect.void }
    const staleA: BridgeHandlerRecord = { Ping: () => Effect.void }

    Effect.runSync(coordinator.register('A', recordA))
    Effect.runSync(coordinator.unregister('A', staleA))
    // The stale record isn't the active one, so A keeps recordA.
    expect(recorder.calls.at(-1)?.[0]).toBe(recordA)

    Effect.runSync(coordinator.unregister('A', recordA))
    // Now A falls back to drop-all.
    expect(recorder.calls.at(-1)?.[0]).not.toBe(recordA)
    expect(typeof recorder.calls.at(-1)?.[0]?.Ping).toBe('function')
  })
})
