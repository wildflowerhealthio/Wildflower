import { renderHook } from '@testing-library/react'
import { Effect, Schema } from 'effect'
import { Bridge, type MessageHandler } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { createElement, type ReactNode } from 'react'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'
import {
  type BridgeHandlerRecord,
  HandlerCoordinatorContext,
  type HandlerCoordinator,
  makeHandlerCoordinator,
  makeUseSliceRegister,
  useHandlerCoordinator,
} from './handler-coordinator.ts'

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
        calls.push(handlers)
      }),
  }
}

describe('makeHandlerCoordinator', () => {
  test('initialHandlers seed boot-stable records; absent bridges are drop-all', () => {
    const seededB: BridgeHandlerRecord = { Pong: () => Effect.void }
    const { initialHandlers } = makeHandlerCoordinator({
      bridges,
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
      initial: {},
    }).connect(recorder.registerHandlers)
    const recordA = { Ping: () => Effect.void }

    Effect.runSync(coordinator.register(A, recordA))

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
      initial: {},
    }).connect(recorder.registerHandlers)
    const recordA = { Ping: () => Effect.void }
    const staleA = { Ping: () => Effect.void }

    Effect.runSync(coordinator.register(A, recordA))
    Effect.runSync(coordinator.unregister(A, staleA))
    // The stale record isn't the active one, so A keeps recordA.
    expect(recorder.calls.at(-1)?.[0]).toBe(recordA)

    Effect.runSync(coordinator.unregister(A, recordA))
    // Now A falls back to drop-all.
    expect(recorder.calls.at(-1)?.[0]).not.toBe(recordA)
    expect(typeof recorder.calls.at(-1)?.[0]?.Ping).toBe('function')
  })

  test('register on A then register on B places each record in its own bridges-order slot', () => {
    const recorder = makeRecorder()
    const coordinator = makeHandlerCoordinator({
      bridges,
      initial: {},
    }).connect(recorder.registerHandlers)
    const recordA = { Ping: () => Effect.void }
    const recordB = { Pong: () => Effect.void }

    Effect.runSync(coordinator.register(A, recordA))
    Effect.runSync(coordinator.register(B, recordB))

    const tuple = recorder.calls.at(-1)
    expect(tuple?.[0]).toBe(recordA)
    expect(tuple?.[1]).toBe(recordB)
  })

  test('property: any register/unregister sequence converges to last-writer-wins per bridge', () => {
    type Op =
      | { readonly kind: 'register'; readonly bridgeIx: 0 | 1; readonly id: number }
      | { readonly kind: 'unregister'; readonly bridgeIx: 0 | 1; readonly id: number }
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant('register' as const),
        bridgeIx: fc.constantFrom(0 as const, 1 as const),
        id: fc.integer({ min: 0, max: 4 }),
      }),
      fc.record({
        kind: fc.constant('unregister' as const),
        bridgeIx: fc.constantFrom(0 as const, 1 as const),
        id: fc.integer({ min: 0, max: 4 }),
      })
    )

    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 20 }), (ops) => {
        const recorder = makeRecorder()
        const coordinator = makeHandlerCoordinator({
          bridges,
          initial: {},
        }).connect(recorder.registerHandlers)

        // One stable record per (bridgeIx, id) so unregister-by-identity works.
        const recordCache = new Map<string, BridgeHandlerRecord>()
        const recordFor = (bridgeIx: 0 | 1, id: number): BridgeHandlerRecord => {
          const key = `${bridgeIx}:${id}`
          const existing = recordCache.get(key)
          if (existing !== undefined) return existing
          const next: BridgeHandlerRecord =
            bridgeIx === 0 ? { Ping: () => Effect.void } : { Pong: () => Effect.void }
          recordCache.set(key, next)
          return next
        }

        // Drive the same sequence against the coordinator and a reference model.
        const model: [BridgeHandlerRecord | null, BridgeHandlerRecord | null] = [null, null]
        for (const op of ops) {
          const record = recordFor(op.bridgeIx, op.id)
          // Branch on the bridge index so each call passes a concrete
          // bridge — the coordinator's `register<B extends Bridge.AnyBridge>`
          // infers `B` precisely and the record's structural shape matches
          // that bridge's HandlersFor without a cast.
          if (op.bridgeIx === 0) {
            // Property-test plumbing: record was built from a synthetic
            // `BridgeHandlerRecord` (the structural-acceptance shape) and
            // is being driven through a typed `HandlersFor<A['HostToWeb']>`
            // for the test's purposes. Cast confined to test.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            const typedRecord = record as MessageHandler.HandlersFor<(typeof A)['HostToWeb']>
            if (op.kind === 'register') {
              Effect.runSync(coordinator.register(A, typedRecord))
              model[0] = record
            } else {
              Effect.runSync(coordinator.unregister(A, typedRecord))
              if (model[0] === record) model[0] = null
            }
          } else {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            const typedRecord = record as MessageHandler.HandlersFor<(typeof B)['HostToWeb']>
            if (op.kind === 'register') {
              Effect.runSync(coordinator.register(B, typedRecord))
              model[1] = record
            } else {
              Effect.runSync(coordinator.unregister(B, typedRecord))
              if (model[1] === record) model[1] = null
            }
          }
        }

        const tuple = recorder.calls.at(-1)
        // For each bridge: either the model has the last registered record
        // (and the recomposed tuple slot is that exact identity), or the
        // bridge has no active record (and the slot is a generated
        // drop-all over that bridge's inbound tags).
        if (ops.length === 0) {
          // No ops → connect never recomposed; nothing to assert beyond no-throw.
          return
        }
        const inboundKey: [string, string] = ['Ping', 'Pong']
        for (const i of [0, 1] as const) {
          const expected = model[i]
          if (expected !== null) {
            expect(tuple?.[i]).toBe(expected)
          } else {
            // Drop-all: the slot is some record (not one of our stored
            // identities) whose inbound tag is a function.
            const slot = tuple?.[i]
            expect(typeof slot?.[inboundKey[i]]).toBe('function')
            for (const stored of recordCache.values()) {
              expect(slot).not.toBe(stored)
            }
          }
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('useHandlerCoordinator', () => {
  test('throws NoContextException outside HandlerCoordinatorContext.Provider', () => {
    // React renders the throwing hook inside an ErrorBoundary and logs a
    // noisy stack; silence it so the test output stays clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => renderHook(() => useHandlerCoordinator())).toThrow(NoContextException)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('makeUseSliceRegister', () => {
  test('pre-applies the bridge so register/unregister take only handlers', () => {
    const recorder = makeRecorder()
    const coordinator = makeHandlerCoordinator({ bridges, initial: {} }).connect(
      recorder.registerHandlers
    )
    const useARegister = makeUseSliceRegister(A)
    const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
      createElement(HandlerCoordinatorContext.Provider, { value: coordinator }, children)

    const { result } = renderHook(() => useARegister(), { wrapper })
    const recordA = { Ping: () => Effect.void }
    Effect.runSync(result.current.register(recordA))

    expect(recorder.calls.at(-1)?.[0]).toBe(recordA)
  })

  test('returns a stable register/unregister pair across rerenders when the coordinator is identity-stable', () => {
    const recorder = makeRecorder()
    const coordinator: HandlerCoordinator = makeHandlerCoordinator({
      bridges,
      initial: {},
    }).connect(recorder.registerHandlers)
    const useARegister = makeUseSliceRegister(A)
    const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
      createElement(HandlerCoordinatorContext.Provider, { value: coordinator }, children)

    const { result, rerender } = renderHook(() => useARegister(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
