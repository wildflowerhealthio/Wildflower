// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the
// real `sendCollectorMessage` is `ExpoTransport<Bridges>['sendMessage']`,
// a highly-generic structural function type; tests reduce it through an
// `unknown` bridge cast so we don't have to reconstruct the full bridge
// schema universe for every assertion.
import { render } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { Effect as EffectType } from 'effect'
import * as React from 'react'
import type { ReactElement } from 'react'

import type { SnifferHandlers } from 'browser-sniffer-expo'

// Capture the handlers `BrowserSnifferWebView` received so the test
// can invoke them directly without driving a native runtime.
let mockLastSnifferHandlers: SnifferHandlers | null = null

// Stub `browser-sniffer-expo` — the real module imports
// `react-native-webview`, which fails outside a native runtime.
jest.mock('browser-sniffer-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BrowserSnifferWebView: ReactInner.forwardRef(function MockBrowserSnifferWebView(
      props: { readonly handlers: SnifferHandlers },
      _ref: unknown
    ): ReactElement {
      mockLastSnifferHandlers = props.handlers
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

import { RunSyncModalScreen, type RunSyncModalScreenProps } from './RunSyncModalScreen.tsx'

/**
 * Mocked `sendCollectorMessage` shape. The real signature is the
 * structurally-rich `ExpoTransport<Bridges>['sendMessage']`; for the
 * purposes of these tests we just need a callable that records the
 * forwarded message and returns an Effect. The `unknown`-bridge cast
 * keeps `no-unsafe-type-assertion` quiet (the rule rejects `as never`
 * specifically, but tolerates `as unknown as T` for test scaffolding).
 */
type SendCollectorMessage = RunSyncModalScreenProps['sendCollectorMessage']
const buildSendCollectorMessage = (
  push: (event: { readonly _tag: string }) => void
): SendCollectorMessage => {
  const send = (event: { readonly _tag: string }): EffectType.Effect<void> =>
    Effect.sync(() => {
      push(event)
    })
  return send as unknown as SendCollectorMessage
}

beforeEach(() => {
  mockLastSnifferHandlers = null
})

describe('RunSyncModalScreen', () => {
  describe('RequestError handler', () => {
    it('forwards the event through sendCollectorMessage even if onError throws', async () => {
      const sendCalls: Array<{ readonly _tag: string }> = []
      const sendCollectorMessage = buildSendCollectorMessage((e) => sendCalls.push(e))
      const onError = jest.fn((): void => {
        throw new Error('boom from onError')
      })

      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          sendCollectorMessage={sendCollectorMessage}
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

      // Drive the RequestError handler — run the resulting Effect end
      // to end. The improved ordering means the bridge message is
      // forwarded first; the synchronous throw inside `onError` is
      // caught by `Effect.catchAllCause` and logged, not propagated.
      await Effect.runPromise(handlers.RequestError(fakeEvent))

      // Even though onError threw, the bridge message was forwarded.
      expect(sendCalls).toEqual([fakeEvent])
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(fakeEvent)
    })

    it('still forwards through sendCollectorMessage when onError is undefined', async () => {
      const sendCalls: Array<{ readonly _tag: string }> = []
      const sendCollectorMessage = buildSendCollectorMessage((e) => sendCalls.push(e))

      render(
        <RunSyncModalScreen
          source={{ _tag: 'Html', html: '<html></html>' }}
          sendCollectorMessage={sendCollectorMessage}
        />
      )

      const handlers = mockLastSnifferHandlers
      expect(handlers).not.toBeNull()
      if (handlers === null) return

      const fakeEvent = {
        _tag: 'RequestError' as const,
        id: 'r2',
        url: 'https://example.test',
        message: 'oh no',
      }
      await Effect.runPromise(handlers.RequestError(fakeEvent))
      expect(sendCalls).toEqual([fakeEvent])
    })
  })
})
