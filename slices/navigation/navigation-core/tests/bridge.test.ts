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

  test('Web send encodes a Log with level + payload array and Host decodes it', () => {
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make({})
    Effect.runSync(
      NavigationBridge.Web.send({
        _tag: 'Log',
        level: 'warn',
        payload: ['count', 3, { ctx: 'navigation' }],
      }).pipe(Effect.provide(adapterLayer))
    )
    const decoded = Schema.decodeSync(NavigationBridge.Host.InboundSchemas.Log)(sentSink[0])
    expect(decoded).toEqual({
      _tag: 'Log',
      level: 'warn',
      payload: ['count', 3, { ctx: 'navigation' }],
    })
  })
})
