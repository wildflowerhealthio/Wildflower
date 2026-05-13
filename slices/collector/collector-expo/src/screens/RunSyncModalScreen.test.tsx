import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import * as React from 'react'
import type { ReactElement } from 'react'

import type { SnifferHandlers } from 'browser-sniffer-expo'

// Capture the props `BrowserSnifferWebView` received so the test can
// invoke typed handlers directly (no native runtime needed), drive
// `onRawMessage` to assert raw passthrough, and observe source
// changes from scripted navigation.
let mockLastSnifferHandlers: SnifferHandlers | null = null
let mockLastSnifferSource: unknown = null
let mockLastOnRawMessage: ((raw: string) => void) | null = null
let mockSnifferPostRawCalls: string[] = []

// Stub `browser-sniffer-expo` — the real module imports
// `react-native-webview`, which fails outside a native runtime. The
// stubbed ref exposes a `postRaw` that pushes onto a shared array so
// tests can assert the screen's handleRef-driven raw forwarder.
jest.mock('browser-sniffer-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BrowserSnifferWebView: ReactInner.forwardRef(function MockBrowserSnifferWebView(
      props: {
        readonly handlers: SnifferHandlers
        readonly source: unknown
        readonly onRawMessage?: (raw: string) => void
      },
      ref: React.Ref<{ readonly postRaw: (raw: string) => void }>
    ): ReactElement {
      mockLastSnifferHandlers = props.handlers
      mockLastSnifferSource = props.source
      mockLastOnRawMessage = props.onRawMessage ?? null
      ReactInner.useImperativeHandle(ref, () => ({
        postRaw: (raw: string): void => {
          mockSnifferPostRawCalls.push(raw)
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

import { RunSyncModalScreen, type RunSyncModalScreenHandle } from './RunSyncModalScreen.tsx'

beforeEach(() => {
  mockLastSnifferHandlers = null
  mockLastSnifferSource = null
  mockLastOnRawMessage = null
  mockSnifferPostRawCalls = []
})

describe('RunSyncModalScreen', () => {
  describe('raw passthrough to the SPA', () => {
    it.each([
      ['ResponseStart', { _tag: 'ResponseStart', id: 'r1', url: 'u', status: 200 }],
      ['ResponseData', { _tag: 'ResponseData', id: 'r1', data: 'b64' }],
      ['ResponseFinished', { _tag: 'ResponseFinished', id: 'r1' }],
      ['RequestError', { _tag: 'RequestError', id: 'r1', url: 'u', message: 'm' }],
      ['Cancelled', { _tag: 'Cancelled', id: 'r1' }],
      ['PageLoaded', { _tag: 'PageLoaded', url: 'u', pageContentId: 'p' }],
    ])('forwards %s raw wire strings verbatim into postRawCollectorMessage', (_tag, payload) => {
      const rawCalls: string[] = []
      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          postRawCollectorMessage={(raw) => rawCalls.push(raw)}
        />
      )
      expect(mockLastOnRawMessage).not.toBeNull()
      const raw = JSON.stringify(payload)
      mockLastOnRawMessage?.(raw)
      expect(rawCalls).toEqual([raw])
    })

    it('drops non-passthrough tags (Log) without forwarding', () => {
      const rawCalls: string[] = []
      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          postRawCollectorMessage={(raw) => rawCalls.push(raw)}
        />
      )
      mockLastOnRawMessage?.(JSON.stringify({ _tag: 'Log', log: 'spam' }))
      mockLastOnRawMessage?.(JSON.stringify({ _tag: '__Ready' }))
      expect(rawCalls).toEqual([])
    })

    it('silently drops malformed JSON without forwarding', () => {
      const rawCalls: string[] = []
      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          postRawCollectorMessage={(raw) => rawCalls.push(raw)}
        />
      )
      mockLastOnRawMessage?.('not json')
      mockLastOnRawMessage?.('null')
      mockLastOnRawMessage?.('"plain string"')
      expect(rawCalls).toEqual([])
    })
  })

  describe('RequestError typed handler', () => {
    it('still fires onError even though the wire forward goes via raw', async () => {
      const onError = jest.fn()
      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          postRawCollectorMessage={() => undefined}
          onError={onError}
        />
      )
      const handlers = mockLastSnifferHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return
      const fakeEvent = {
        _tag: 'RequestError' as const,
        id: 'r1',
        url: 'https://example.test',
        message: 'oh no',
      }
      await Effect.runPromise(handlers.RequestError(fakeEvent))
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(fakeEvent)
    })

    it('swallows onError throws so the dispatch fiber keeps draining', async () => {
      const onError = jest.fn((): void => {
        throw new Error('boom')
      })
      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          postRawCollectorMessage={() => undefined}
          onError={onError}
        />
      )
      const handlers = mockLastSnifferHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return
      // `Effect.catchAllCause` inside the handler logs and recovers;
      // `runPromise` resolves rather than rejecting.
      await expect(
        Effect.runPromise(
          handlers.RequestError({
            _tag: 'RequestError',
            id: 'r1',
            url: 'https://example.test',
            message: 'boom',
          })
        )
      ).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledTimes(1)
    })
  })

  describe('navigate() handle', () => {
    it('mounts a fresh source when the parent screen calls navigate', () => {
      const handleRef = React.createRef<RunSyncModalScreenHandle>()
      render(
        <RunSyncModalScreen
          source={{ _tag: 'Uri', uri: 'https://example.test/a' }}
          postRawCollectorMessage={() => undefined}
          handleRef={handleRef}
        />
      )
      // The untagged source the mock receives mirrors react-native-webview's
      // shape (no `_tag`); strip it from the expected payload too.
      expect(mockLastSnifferSource).toEqual({ uri: 'https://example.test/a' })

      // Drive a scripted Open: the parent screen would normally call
      // this in response to CollectorWebView's `onOpen` callback. Wrap
      // the setState dispatch in `act` so the re-render flushes before
      // we read the mock's captured source.
      expect(handleRef.current).not.toBeNull()
      act(() => {
        handleRef.current?.navigate({ _tag: 'Uri', uri: 'https://example.test/b' })
      })
      expect(mockLastSnifferSource).toEqual({ uri: 'https://example.test/b' })
    })
  })

  describe('postRawSnifferMessage handle', () => {
    it('forwards raw wire strings into the sniffer ref verbatim', () => {
      const handleRef = React.createRef<RunSyncModalScreenHandle>()
      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          postRawCollectorMessage={() => undefined}
          handleRef={handleRef}
        />
      )
      const raw = JSON.stringify({ _tag: 'Click', querySelector: '#go' })
      handleRef.current?.postRawSnifferMessage(raw)
      expect(mockSnifferPostRawCalls).toEqual([raw])
    })
  })
})
