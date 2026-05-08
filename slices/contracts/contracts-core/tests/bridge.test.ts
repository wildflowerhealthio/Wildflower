import { Effect, Either, Schema } from 'effect'
import { TestPlatformAdapterLayer } from 'effect-messaging-core'
import { describe, expect, test } from 'vite-plus/test'
import NavigationBridge from '../src/navigation-bridge.ts'

describe('HostBackRequested', () => {
  test('round-trips through encode/decode', () => {
    const encoded = Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
      _tag: 'HostBackRequested',
    })
    expect(typeof encoded).toBe('string')
    const decoded = Schema.decodeSync(NavigationBridge.MessageSchemas.HostBackRequested)(encoded)
    expect(decoded).toEqual({ _tag: 'HostBackRequested' })
  })

  test('rejects malformed JSON', () => {
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(NavigationBridge.MessageSchemas.HostBackRequested)('not-json')
      )
    ).toBe(true)
  })

  test('rejects a different _tag', () => {
    const wrong = JSON.stringify({ _tag: 'SomethingElse' })
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(NavigationBridge.MessageSchemas.HostBackRequested)(wrong)
      )
    ).toBe(true)
  })
})

describe('HostRequestedWebNavigation', () => {
  test('round-trips with a path', () => {
    const encoded = Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
      _tag: 'HostRequestedWebNavigation',
      path: '/gatekeeper/oauth-consent/abc',
    })
    const decoded = Schema.decodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)(
      encoded
    )
    expect(decoded.path).toBe('/gatekeeper/oauth-consent/abc')
  })

  test('rejects when path is missing', () => {
    const wrong = JSON.stringify({ _tag: 'HostRequestedWebNavigation' })
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)(
          wrong
        )
      )
    ).toBe(true)
  })
})

describe('RouteChanged', () => {
  test('round-trips with pathname + canGoBack', () => {
    const encoded = Schema.encodeSync(NavigationBridge.MessageSchemas.RouteChanged)({
      _tag: 'RouteChanged',
      pathname: '/x',
      canGoBack: true,
    })
    const decoded = Schema.decodeSync(NavigationBridge.MessageSchemas.RouteChanged)(encoded)
    expect(decoded).toEqual({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
  })

  test('rejects when canGoBack is the wrong type', () => {
    const wrong = JSON.stringify({ _tag: 'RouteChanged', pathname: '/x', canGoBack: 'yes' })
    expect(
      Either.isLeft(Schema.decodeUnknownEither(NavigationBridge.MessageSchemas.RouteChanged)(wrong))
    ).toBe(true)
  })
})

describe('NavigationBridge', () => {
  test('Host side sends hostToWeb tags and receives webToHost tags', () => {
    expect(Object.keys(NavigationBridge.Host.OutboundSchemas).toSorted()).toEqual([
      'HostBackRequested',
      'HostRequestedWebNavigation',
    ])
    expect(Object.keys(NavigationBridge.Host.InboundSchemas)).toEqual(['RouteChanged'])
  })

  test('Web side mirrors the Host side (outbound/inbound swapped)', () => {
    expect(Object.keys(NavigationBridge.Web.OutboundSchemas)).toEqual(['RouteChanged'])
    expect(Object.keys(NavigationBridge.Web.InboundSchemas).toSorted()).toEqual([
      'HostBackRequested',
      'HostRequestedWebNavigation',
    ])
  })

  test('schema instances on the bridge match the standalone exports', () => {
    expect(NavigationBridge.Host.OutboundSchemas.HostBackRequested).toBe(
      NavigationBridge.MessageSchemas.HostBackRequested
    )
    expect(NavigationBridge.Host.OutboundSchemas.HostRequestedWebNavigation).toBe(
      NavigationBridge.MessageSchemas.HostRequestedWebNavigation
    )
    expect(NavigationBridge.Web.OutboundSchemas.RouteChanged).toBe(
      NavigationBridge.MessageSchemas.RouteChanged
    )
  })

  test('HandlerTag keys reflect the bridge name + side', () => {
    expect(NavigationBridge.Host.HandlerTag.key).toBe('Navigation.Host.HandlerTag')
    expect(NavigationBridge.Web.HandlerTag.key).toBe('Navigation.Web.HandlerTag')
  })

  test('hostOptionsShape decodes the documented `{ initialPath }` shape', () => {
    const decoded = Schema.decodeUnknownSync(NavigationBridge.Host.OptionsShape)({
      initialPath: '/gatekeeper',
    })
    expect(decoded).toEqual({ initialPath: '/gatekeeper' })
  })

  test('webOptionsShape accepts an empty object', () => {
    const decoded = Schema.decodeUnknownSync(NavigationBridge.Web.OptionsShape)({})
    expect(decoded).toEqual({})
  })

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
})
