import { renderHook } from '@testing-library/react'
import { Effect, Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'
import { createElement, type ReactNode } from 'react'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'
import {
  type BridgeHandlerRecord,
  HandlerCoordinatorContext,
  type HandlerCoordinator,
  makeUseSliceRegister,
  useHandlerCoordinator,
} from './handler-coordinator.ts'

const A = Bridge.make({
  name: 'A',
  hostToWeb: [['Ping', Schema.parseJson(Schema.TaggedStruct('Ping', {}))]] as const,
  webToHost: [] as const,
})

/** A {@link HandlerCoordinator} that records every `register` call. */
const makeRecordingCoordinator = (): {
  readonly registered: Array<readonly [Bridge.AnyBridge, BridgeHandlerRecord]>
  readonly coordinator: HandlerCoordinator
} => {
  const registered: Array<readonly [Bridge.AnyBridge, BridgeHandlerRecord]> = []
  return {
    registered,
    coordinator: {
      register: (bridge, handlers) =>
        Effect.sync(() => {
          registered.push([bridge, handlers])
        }),
      unregister: () => Effect.void,
    },
  }
}

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
    const { registered, coordinator } = makeRecordingCoordinator()
    const useARegister = makeUseSliceRegister(A)
    const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
      createElement(HandlerCoordinatorContext.Provider, { value: coordinator }, children)

    const { result } = renderHook(() => useARegister(), { wrapper })
    const recordA = { Ping: () => Effect.void }
    Effect.runSync(result.current.register(recordA))

    expect(registered).toEqual([[A, recordA]])
    expect(registered[0]?.[1]).toBe(recordA)
  })

  test('returns a stable register/unregister pair across rerenders when the coordinator is identity-stable', () => {
    const { coordinator } = makeRecordingCoordinator()
    const useARegister = makeUseSliceRegister(A)
    const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
      createElement(HandlerCoordinatorContext.Provider, { value: coordinator }, children)

    const { result, rerender } = renderHook(() => useARegister(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
