import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeNamedPipe } from './make-named-pipe.tsx'
import { testBridges, type TestBridges } from './test-utils/test-bridges.ts'
import { makeRecordingSender } from './test-utils/test-recording-sender.ts'

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('makeNamedPipe', () => {
  test('Provider has a `${name}PipeProvider` displayName', () => {
    const { Provider } = makeNamedPipe('BrowserSniffer', testBridges, 'Host')
    expect(Provider.displayName).toBe('BrowserSnifferPipeProvider')
  })

  test('useSender returns the default warn-and-drop handler before useAsSource runs', async () => {
    const { Provider, useSender } = makeNamedPipe('Test', testBridges, 'Host')

    const { result } = renderHook(() => useSender(), {
      wrapper: ({ children }) => <Provider>{children}</Provider>,
    })

    const exit = await Effect.runPromise(Effect.exit(result.current({ _tag: 'HostBackRequested' })))
    expect(exit._tag).toBe('Success')
  })

  test('useAsSource → useSender forwards to the registered sender', async () => {
    const { Provider, useAsSource, useSender } = makeNamedPipe('Test', testBridges, 'Host')
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    const { result } = renderHook(
      () => {
        useAsSource(sender)
        return useSender()
      },
      {
        wrapper: ({ children }) => <Provider>{children}</Provider>,
      }
    )

    await Effect.runPromise(result.current({ _tag: 'HostRequestedWebNavigation', path: '/x' }))
    expect(received).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/x' }])
  })

  test('useSender returns an identity-stable function across re-renders', () => {
    const { Provider, useSender } = makeNamedPipe('Test', testBridges, 'Host')

    const { result, rerender } = renderHook(() => useSender(), {
      wrapper: ({ children }) => <Provider>{children}</Provider>,
    })

    const first = result.current
    rerender()
    const second = result.current

    expect(Object.is(first, second)).toBe(true)
  })

  test('useSender throws NoContextException outside Provider', () => {
    const { useSender } = makeNamedPipe('Test', testBridges, 'Host')
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useSender())).toThrow(NoContextException)
    } finally {
      restore()
    }
  })

  test('useAsSource throws NoContextException outside Provider', () => {
    const { useAsSource } = makeNamedPipe('Test', testBridges, 'Host')
    const { sender } = makeRecordingSender<TestBridges, 'Host'>()
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useAsSource(sender))).toThrow(NoContextException)
    } finally {
      restore()
    }
  })

  test('two pipes from the same factory are isolated (separate registries)', async () => {
    const a = makeNamedPipe('A', testBridges, 'Host')
    const b = makeNamedPipe('B', testBridges, 'Host')
    const recordingA = makeRecordingSender<TestBridges, 'Host'>()
    const recordingB = makeRecordingSender<TestBridges, 'Host'>()

    const { result } = renderHook(
      () => {
        a.useAsSource(recordingA.sender)
        b.useAsSource(recordingB.sender)
        return { aSender: a.useSender(), bSender: b.useSender() }
      },
      {
        wrapper: ({ children }) => (
          <a.Provider>
            <b.Provider>{children}</b.Provider>
          </a.Provider>
        ),
      }
    )

    await Effect.runPromise(result.current.aSender({ _tag: 'HostBackRequested' }))
    expect(recordingA.received).toEqual([{ _tag: 'HostBackRequested' }])
    expect(recordingB.received).toEqual([])
  })
})
