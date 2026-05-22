import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import { BareSender } from 'effect-messaging-core'
import * as React from 'react'
import type { ReactElement } from 'react'

import type { SnifferHandlers } from 'browser-sniffer-expo'

/** Stub `BareSender` for direct handler invocation. */
const provideNoopBareSender = Effect.provideService(BareSender, {
  bareSender: () => Effect.void,
})

// Capture the props `BrowserSnifferWebView` received so the test can
// invoke typed handlers directly (no native runtime needed) and observe
// source changes from scripted navigation.
let mockLastSnifferHandlers: SnifferHandlers | null = null
let mockLastSnifferSource: unknown = null
let mockSnifferClickCalls: string[] = []
let mockSnifferCancelCalls: string[] = []

// Stub `browser-sniffer-expo` — the real module imports
// `react-native-webview`, which fails outside a native runtime. The
// stubbed ref exposes `click` / `cancelRequest` methods so tests can
// assert the screen's snifferControlRef wiring.
jest.mock('browser-sniffer-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BrowserSnifferWebView: ReactInner.forwardRef(function MockBrowserSnifferWebView(
      props: {
        readonly handlers: SnifferHandlers
        readonly source: unknown
      },
      ref: React.Ref<{
        readonly click: (qs: string) => void
        readonly cancelRequest: (id: string) => void
      }>
    ): ReactElement {
      mockLastSnifferHandlers = props.handlers
      mockLastSnifferSource = props.source
      ReactInner.useImperativeHandle(ref, () => ({
        click: (qs: string): void => {
          mockSnifferClickCalls.push(qs)
        },
        cancelRequest: (id: string): void => {
          mockSnifferCancelCalls.push(id)
        },
      }))
      return ReactInner.createElement('MockBrowserSnifferWebView', props)
    }),
  }
})

// Stub `expo-tundraish` — its barrel imports reanimated which trips
// TurboModules under jest.
jest.mock('expo-tundraish', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    Spacing: { s5: 16 },
    ThemedView: (props: { readonly children?: React.ReactNode }): ReactElement =>
      ReactInner.createElement('ThemedView', props),
  }
})

// Capture sendEffect calls from the typed re-emit path. Returns an
// Effect that records the message and resolves immediately. The factory
// uses `jest.requireActual` for the Effect module — jest-hoist forbids
// referencing outer-scope imports, so the real `effect` module is
// resolved lazily inside the factory.
let mockReEmittedMessages: Array<{ readonly _tag: string }> = []
jest.mock('collector-react', () => {
  const effect = jest.requireActual<{ Effect: typeof Effect }>('effect')
  return {
    useCollectorHostMessaging: (): {
      readonly send: (msg: { readonly _tag: string }) => void
      readonly sendEffect: (msg: { readonly _tag: string }) => Effect.Effect<void>
    } => ({
      send: (msg) => {
        mockReEmittedMessages.push(msg)
      },
      sendEffect: (msg) =>
        effect.Effect.sync(() => {
          mockReEmittedMessages.push(msg)
        }),
    }),
  }
})

// `CollectorModalScreen` reads `snifferControlRef` from the host
// context. The `mock` prefix is required by babel-plugin-jest-hoist
// to leave the binding alone when hoisting `jest.mock` calls. The
// factory closes over `mockHostStub` to expose the same ref object the
// suite asserts against post-mount.
const mockHostStub = {
  snifferControlRef: {
    current: null as null | { click: (qs: string) => void; cancelRequest: (id: string) => void },
  },
}
jest.mock('../host-receiver-layer.tsx', () => ({
  useHost: (): typeof mockHostStub => mockHostStub,
}))

import { CollectorModalScreen, type CollectorModalScreenHandle } from './CollectorModalScreen.tsx'

beforeEach(() => {
  mockLastSnifferHandlers = null
  mockLastSnifferSource = null
  mockSnifferClickCalls = []
  mockSnifferCancelCalls = []
  mockReEmittedMessages = []
  mockHostStub.snifferControlRef.current = null
})

describe('CollectorModalScreen', () => {
  describe('typed re-emit through CollectorBridge', () => {
    // The browser-sniffer bridge schemas are stubbed in this suite to an
    // empty `InboundSchemas` record, so the SnifferHandlers type collapses
    // to `Record<string, unknown>`. The runtime check is what matters:
    // each handler key invoked with a tagged event must re-emit the same
    // message through `useCollectorHostMessaging`.
    type Case = readonly [string, { readonly _tag: string } & Readonly<Record<string, unknown>>]
    const cases: ReadonlyArray<Case> = [
      ['ResponseStart', { _tag: 'ResponseStart', id: 'r1', url: 'u', status: 200 }],
      ['ResponseData', { _tag: 'ResponseData', id: 'r1', data: 'b64' }],
      ['ResponseFinished', { _tag: 'ResponseFinished', id: 'r1' }],
      ['Cancelled', { _tag: 'Cancelled', id: 'r1' }],
      ['PageLoaded', { _tag: 'PageLoaded', url: 'u', pageContentId: 'p' }],
    ]
    it.each(cases)(
      're-emits %s through useCollectorHostMessaging.sendEffect',
      async (tag, event) => {
        render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
        expect(mockLastSnifferHandlers).not.toBeNull()
        // SnifferHandlers in this suite is stubbed to an empty record
        // (see browser-sniffer-core/bridge mock above), so we read the
        // captured handlers via an index lookup. The runtime check is
        // what matters: each handler key invoked with a tagged event
        // must re-emit the same message through useCollectorHostMessaging.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const handlersRecord = mockLastSnifferHandlers as unknown as Readonly<
          Record<string, ((e: unknown) => Effect.Effect<void>) | undefined>
        >
        const handler = handlersRecord[tag]
        expect(handler).toBeDefined()
        if (handler === undefined) return
        await Effect.runPromise(handler(event).pipe(provideNoopBareSender))
        expect(mockReEmittedMessages).toEqual([event])
      }
    )
  })

  describe('RequestError typed handler', () => {
    it('re-emits RequestError AND fires the host-local onError callback', async () => {
      const onError = jest.fn()
      render(
        <CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} onError={onError} />
      )
      const handlers = mockLastSnifferHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return
      const event = {
        _tag: 'RequestError' as const,
        id: 'r1',
        url: 'https://example.test',
        message: 'oh no',
      }
      await Effect.runPromise(handlers.RequestError(event).pipe(provideNoopBareSender))
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(event)
      expect(mockReEmittedMessages).toEqual([event])
    })

    it('swallows onError throws so the dispatch fiber keeps draining and still re-emits', async () => {
      const onError = jest.fn((): void => {
        throw new Error('boom')
      })
      render(
        <CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} onError={onError} />
      )
      const handlers = mockLastSnifferHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return
      const event = {
        _tag: 'RequestError' as const,
        id: 'r1',
        url: 'https://example.test',
        message: 'boom',
      }
      await expect(
        Effect.runPromise(handlers.RequestError(event).pipe(provideNoopBareSender))
      ).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(mockReEmittedMessages).toEqual([event])
    })
  })

  describe('snifferControlRef registration', () => {
    it('registers click / cancelRequest into the host context on mount', () => {
      render(<CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />)
      expect(mockHostStub.snifferControlRef.current).not.toBeNull()
      mockHostStub.snifferControlRef.current?.click('#submit')
      mockHostStub.snifferControlRef.current?.cancelRequest('req-1')
      expect(mockSnifferClickCalls).toEqual(['#submit'])
      expect(mockSnifferCancelCalls).toEqual(['req-1'])
    })

    it('clears the ref on unmount', () => {
      const { unmount } = render(
        <CollectorModalScreen source={{ _tag: 'Html', html: '<html></html>' }} />
      )
      expect(mockHostStub.snifferControlRef.current).not.toBeNull()
      unmount()
      expect(mockHostStub.snifferControlRef.current).toBeNull()
    })
  })

  describe('navigate() handle', () => {
    it('mounts a fresh source when the parent screen calls navigate', () => {
      const handleRef = React.createRef<CollectorModalScreenHandle>()
      render(
        <CollectorModalScreen
          source={{ _tag: 'Uri', uri: 'https://example.test/a' }}
          handleRef={handleRef}
        />
      )
      // The untagged source the mock receives mirrors react-native-webview's
      // shape (no `_tag`); strip it from the expected payload too.
      expect(mockLastSnifferSource).toEqual({ uri: 'https://example.test/a' })

      // Drive a scripted Open: the parent screen would normally call
      // this in response to the host shell's `onOpen` callback. Wrap
      // the setState dispatch in `act` so the re-render flushes before
      // we read the mock's captured source.
      expect(handleRef.current).not.toBeNull()
      act(() => {
        handleRef.current?.navigate({ _tag: 'Uri', uri: 'https://example.test/b' })
      })
      expect(mockLastSnifferSource).toEqual({ uri: 'https://example.test/b' })
    })

    it('mounts a fresh Html source when navigate is called with an Html WebViewSource', () => {
      // Parallel to the `Uri` test above: the `Html` branch in
      // `untaggedSource` also strips `_tag` and forwards the rest of
      // the source verbatim (currently `{ html }`). Pins that the
      // handle-driven re-mount works for both source shapes.
      const handleRef = React.createRef<CollectorModalScreenHandle>()
      render(
        <CollectorModalScreen
          source={{ _tag: 'Html', html: '<html><body>initial</body></html>' }}
          handleRef={handleRef}
        />
      )
      expect(mockLastSnifferSource).toEqual({ html: '<html><body>initial</body></html>' })

      expect(handleRef.current).not.toBeNull()
      act(() => {
        handleRef.current?.navigate({
          _tag: 'Html',
          html: '<html><body>navigated</body></html>',
        })
      })
      expect(mockLastSnifferSource).toEqual({ html: '<html><body>navigated</body></html>' })
    })
  })
})
