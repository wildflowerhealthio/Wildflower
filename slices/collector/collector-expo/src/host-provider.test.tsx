/**
 * Routing-side tests for {@link CollectorBridgeExpo.HostProvider} +
 * {@link CollectorBridgeExpo.useReceiverLayer} — every test in this
 * file exercises `RequestSniffableWebView`'s `router.push` /
 * `pendingSource` plumbing, its source-scheme guard, or the `Open`
 * handler's `pendingSource` re-mount path.
 *
 * Sister file: `host-provider-control.test.tsx` covers the
 * sniffer-control forwarders (`Click`, `CancelSnifferRequest`) and
 * the modal-close path (`SniffingComplete`). Shared mocks +
 * handler-capture harness live in
 * `__test-support__/host-provider-test-mocks.ts`.
 */
import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
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
// function literal even when delegating to a `mock*`-prefixed import.
// Wrapping each call lets the shared harness module still own the
// actual mock-construction logic.
jest.mock('expo-router', () => mockBuildExpoRouterFactory())
jest.mock('collector-fundamentals/bridge', () => mockBuildCollectorBridgeFactory())
jest.mock('browser-sniffer-expo', () => mockBuildBrowserSnifferExpoFactory())
jest.mock('expo-tundraish', () => mockBuildExpoTundraishFactory())

import { CollectorBridgeExpo } from './index.ts'

const TestProbe = ({
  onReady,
}: {
  readonly onReady: (host: ReturnType<typeof CollectorBridgeExpo.useHost>) => void
}): ReactElement | null => {
  // Build the layer so the receiver-layer mock captures handlers.
  CollectorBridgeExpo.useReceiverLayer()
  const host = CollectorBridgeExpo.useHost()
  onReady(host)
  return null
}

beforeEach(() => {
  resetHarness()
})

describe('CollectorBridgeExpo.HostProvider + useReceiverLayer (routing)', () => {
  it('RequestSniffableWebView updates pendingSource and pushes the modal route', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()
    expect(seenHosts[0]?.pendingSource).toBeNull()

    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({
          _tag: 'RequestSniffableWebView',
          source: { _tag: 'Uri', uri: 'https://example.com' },
        })
      )
    })

    expect(harness.routerPush).toHaveBeenCalledWith('/collector-modal')
    const lastHost = seenHosts[seenHosts.length - 1]
    expect(lastHost?.pendingSource).toEqual({ _tag: 'Uri', uri: 'https://example.com' })
  })

  it('honors a custom modalPath on the provider', () => {
    render(
      <CollectorBridgeExpo.HostProvider modalPath="/custom-modal">
        <TestProbe onReady={() => undefined} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({
          _tag: 'RequestSniffableWebView',
          source: { _tag: 'Uri', uri: 'https://example.com' },
        })
      )
    })

    expect(harness.routerPush).toHaveBeenCalledWith('/custom-modal')
  })

  // The host-side defense-in-depth check in `useReceiverLayer` refuses
  // any `{_tag: 'Uri'}` URI that doesn't start with `http(s)://`. The
  // bridge schema already pins `Uri` to `https://` only, so this branch
  // is belt-and-suspenders — pin it explicitly against a denylist of
  // suspicious schemes so a regression in the predicate (e.g.
  // accidentally allowing `data:` or `vbscript:`) fails loudly.
  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:text/html,<script>alert(1)</script>'],
    ['blob:https://example.com/abc-def'],
    ['ftp://example.com/file'],
    ['vbscript:msgbox(1)'],
  ])('drops a non-http(s) URI (%s) without touching the router (defense-in-depth)', (uri) => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({
          _tag: 'RequestSniffableWebView',
          source: { _tag: 'Uri', uri },
        })
      )
    })

    expect(harness.routerPush).not.toHaveBeenCalled()
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toBeNull()
  })

  it('Html source bypasses the http(s) predicate and pushes the modal route', () => {
    // The `{_tag: 'Html'}` branch isn't subject to the URI scheme
    // check — only `{_tag: 'Uri'}` is. Pin that the predicate is
    // tag-keyed and doesn't accidentally swallow Html sources.
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    const htmlSource = { _tag: 'Html' as const, html: '<html><body>ok</body></html>' }
    act(() => {
      Effect.runSync(
        handlers.RequestSniffableWebView({
          _tag: 'RequestSniffableWebView',
          source: htmlSource,
        })
      )
    })

    expect(harness.routerPush).toHaveBeenCalledWith('/collector-modal')
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual(htmlSource)
  })

  it('Open re-mounts pendingSource without pushing the router (modal already open)', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()
    const nextSource = { _tag: 'Uri' as const, uri: 'https://example.com/step-2' }

    act(() => {
      Effect.runSync(handlers.Open({ _tag: 'Open', source: nextSource }))
    })

    expect(harness.routerPush).not.toHaveBeenCalled()
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toEqual(nextSource)
  })
})
