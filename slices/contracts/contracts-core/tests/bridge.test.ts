import { Effect, Schema } from 'effect'
import { TestPlatformAdapterLayer } from 'effect-messaging-core'
import { describe, expect, test } from 'vite-plus/test'
import NavigationBridge from '../src/navigation-bridge.ts'

describe('NavigationBridge', () => {
  test('Host send encodes a HostRequestedWebNavigation and the Web side decodes it', () => {
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make({})
    Effect.runSync(
      NavigationBridge.Host.send({
        _tag: 'HostRequestedWebNavigation',
        path: '/foo',
      }).pipe(Effect.provide(adapterLayer))
    )
    const decoded = Schema.decodeSync(
      NavigationBridge.Web.InboundSchemas.HostRequestedWebNavigation
    )(sentSink[0])
    expect(decoded).toEqual({ _tag: 'HostRequestedWebNavigation', path: '/foo' })
  })

  test('Web send encodes a RouteChanged and the Host side decodes it', () => {
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make({})
    Effect.runSync(
      NavigationBridge.Web.send({
        _tag: 'RouteChanged',
        pathname: '/x',
        canGoBack: true,
      }).pipe(Effect.provide(adapterLayer))
    )
    const decoded = Schema.decodeSync(NavigationBridge.Host.InboundSchemas.RouteChanged)(
      sentSink[0]
    )
    expect(decoded).toEqual({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
  })

  // Aggregator contract: slice-expo packages map `hostOptions.initialPath`
  // to `HostRequestedWebNavigation.path`. Pin the mapping so a rename fails here.
  test('hostOptions { initialPath } feeds HostRequestedWebNavigation.path on the wire', () => {
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make({})
    const opts = Schema.decodeUnknownSync(NavigationBridge.Host.OptionsShape)({
      initialPath: '/gatekeeper/oauth-consent/abc',
    })
    Effect.runSync(
      NavigationBridge.Host.send({
        _tag: 'HostRequestedWebNavigation',
        path: opts.initialPath,
      }).pipe(Effect.provide(adapterLayer))
    )
    const decoded = Schema.decodeSync(
      NavigationBridge.Web.InboundSchemas.HostRequestedWebNavigation
    )(sentSink[0])
    expect(decoded.path).toBe('/gatekeeper/oauth-consent/abc')
  })
})
