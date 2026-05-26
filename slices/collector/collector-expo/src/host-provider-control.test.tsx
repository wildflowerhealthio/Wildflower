/**
 * Sniffer-control + modal-close tests for
 * {@link CollectorBridgeExpo.HostProvider} +
 * {@link CollectorBridgeExpo.useReceiverLayer}. Every test here
 * either:
 *
 *  - registers a captured sender via
 *    {@link CollectorBridgeExpo.useAsMessageSenderToBrowserSniffer}
 *    and asserts `Click` / `CancelSnifferRequest` route through it,
 *    or
 *  - asserts the modal-close path (`SniffingComplete` → `router.back()`).
 *
 * Sister file: `host-provider.test.tsx` covers the routing-side
 * handlers (`RequestSniffableWebView` + `Open`). Shared mocks +
 * handler-capture harness live in
 * `__test-support__/host-provider-test-mocks.ts`.
 */
import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import type { ReactElement } from 'react'

import {
  harness,
  mockBuildBrowserSnifferExpoFactory,
  mockBuildCollectorBridgeFactory,
  mockBuildExpoRouterFactory,
  mockBuildExpoTundraishFactory,
  requireLastHandlers,
  resetHarness,
} from './__test-support__/host-provider-test-mocks.ts'

// babel-plugin-jest-hoist requires the factory to be an inline
// function literal; the imported `mockBuild*Factory` helpers are
// invoked from inside that literal so the shared harness module
// (see `__test-support__/host-provider-test-mocks.ts`) still owns
// the actual mock-construction logic.
jest.mock('expo-router', () => mockBuildExpoRouterFactory())
jest.mock('collector-fundamentals/bridge', () => mockBuildCollectorBridgeFactory())
jest.mock('browser-sniffer-expo', () => mockBuildBrowserSnifferExpoFactory())
jest.mock('expo-tundraish', () => mockBuildExpoTundraishFactory())

import type BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { CollectorBridgeExpo } from './index.ts'

type SnifferSender = BridgeTransport.MessageSender<readonly [typeof BrowserSnifferBridge], 'Host'>

const TestProbe = ({ sender }: { readonly sender: SnifferSender }): ReactElement | null => {
  CollectorBridgeExpo.useReceiverLayer()
  CollectorBridgeExpo.useAsMessageSenderToBrowserSniffer(sender)
  return null
}

beforeEach(() => {
  resetHarness()
})

describe('CollectorBridgeExpo handlers — sniffer-control forwarding via pipe', () => {
  it('Click forwards through the registered sender', async () => {
    const calls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const sender: SnifferSender = (msg) => Effect.sync(() => calls.push(msg))

    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe sender={sender} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    await act(async () => {
      await Effect.runPromise(handlers.Click({ _tag: 'Click', querySelector: '#submit' }))
    })

    expect(calls).toEqual([{ _tag: 'Click', querySelector: '#submit' }])
  })

  it('CancelSnifferRequest forwards through the registered sender', async () => {
    const calls: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = []
    const sender: SnifferSender = (msg) => Effect.sync(() => calls.push(msg))

    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe sender={sender} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    await act(async () => {
      await Effect.runPromise(
        handlers.CancelSnifferRequest({ _tag: 'CancelSnifferRequest', id: 'req-1' })
      )
    })

    expect(calls).toEqual([{ _tag: 'CancelSnifferRequest', id: 'req-1' }])
  })

  it('Click routes to the warn-and-drop default when no modal is mounted', async () => {
    // No `TestProbe` calls `useAsMessageSenderToBrowserSniffer` —
    // the pipe's default handler logs a warning and succeeds.
    const NoopProbe = (): ReactElement | null => {
      CollectorBridgeExpo.useReceiverLayer()
      return null
    }
    render(
      <CollectorBridgeExpo.HostProvider>
        <NoopProbe />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    const exit = await Effect.runPromise(
      Effect.exit(handlers.Click({ _tag: 'Click', querySelector: '#submit' }))
    )
    expect(exit._tag).toBe('Success')
  })
})

describe('CollectorBridgeExpo handlers — modal lifecycle', () => {
  it('SniffingComplete calls router.back()', async () => {
    const sender: SnifferSender = () => Effect.void
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe sender={sender} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    await act(async () => {
      await Effect.runPromise(handlers.SniffingComplete({ _tag: 'SniffingComplete' }))
    })

    expect(harness.routerBack).toHaveBeenCalledTimes(1)
    expect(harness.routerPush).not.toHaveBeenCalled()
  })
})
