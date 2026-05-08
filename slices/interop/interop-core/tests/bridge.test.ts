import { Effect, Either, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import {
  NativeBackRequested,
  NativeRequestedWebNavigation,
  NavigationBridge,
  RouteChanged,
} from '../src/bridge.ts'

describe('NativeBackRequested', () => {
  test('round-trips through encode/decode', () => {
    const encoded = Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' })
    expect(typeof encoded).toBe('string')
    const decoded = Schema.decodeSync(NativeBackRequested)(encoded)
    expect(decoded).toEqual({ _tag: 'NativeBackRequested' })
  })

  test('rejects malformed JSON', () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(NativeBackRequested)('not-json'))).toBe(true)
  })

  test('rejects a different _tag', () => {
    const wrong = JSON.stringify({ _tag: 'SomethingElse' })
    expect(Either.isLeft(Schema.decodeUnknownEither(NativeBackRequested)(wrong))).toBe(true)
  })
})

describe('NativeRequestedWebNavigation', () => {
  test('round-trips with a path', () => {
    const encoded = Schema.encodeSync(NativeRequestedWebNavigation)({
      _tag: 'NativeRequestedWebNavigation',
      path: '/gatekeeper/oauth-consent/abc',
    })
    const decoded = Schema.decodeSync(NativeRequestedWebNavigation)(encoded)
    expect(decoded.path).toBe('/gatekeeper/oauth-consent/abc')
  })

  test('rejects when path is missing', () => {
    const wrong = JSON.stringify({ _tag: 'NativeRequestedWebNavigation' })
    expect(Either.isLeft(Schema.decodeUnknownEither(NativeRequestedWebNavigation)(wrong))).toBe(
      true
    )
  })
})

describe('RouteChanged', () => {
  test('round-trips with pathname + canGoBack', () => {
    const encoded = Schema.encodeSync(RouteChanged)({
      _tag: 'RouteChanged',
      pathname: '/x',
      canGoBack: true,
    })
    const decoded = Schema.decodeSync(RouteChanged)(encoded)
    expect(decoded).toEqual({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
  })

  test('rejects when canGoBack is the wrong type', () => {
    const wrong = JSON.stringify({ _tag: 'RouteChanged', pathname: '/x', canGoBack: 'yes' })
    expect(Either.isLeft(Schema.decodeUnknownEither(RouteChanged)(wrong))).toBe(true)
  })
})

describe('NavigationBridge', () => {
  test('Native side sends nativeToWeb tags and receives webToNative tags', () => {
    expect(Object.keys(NavigationBridge.Native.OutboundSchemas).toSorted()).toEqual([
      'NativeBackRequested',
      'NativeRequestedWebNavigation',
    ])
    expect(Object.keys(NavigationBridge.Native.InboundSchemas)).toEqual(['RouteChanged'])
  })

  test('Web side mirrors the Native side (outbound/inbound swapped)', () => {
    expect(Object.keys(NavigationBridge.Web.OutboundSchemas)).toEqual(['RouteChanged'])
    expect(Object.keys(NavigationBridge.Web.InboundSchemas).toSorted()).toEqual([
      'NativeBackRequested',
      'NativeRequestedWebNavigation',
    ])
  })

  test('schema instances on the bridge match the standalone exports', () => {
    expect(NavigationBridge.Native.OutboundSchemas.NativeBackRequested).toBe(NativeBackRequested)
    expect(NavigationBridge.Native.OutboundSchemas.NativeRequestedWebNavigation).toBe(
      NativeRequestedWebNavigation
    )
    expect(NavigationBridge.Web.OutboundSchemas.RouteChanged).toBe(RouteChanged)
  })

  test('HandlerTag keys reflect the bridge name + side', () => {
    expect(NavigationBridge.Native.HandlerTag.key).toBe('Navigation.Native.HandlerTag')
    expect(NavigationBridge.Web.HandlerTag.key).toBe('Navigation.Web.HandlerTag')
  })

  test('nativeOptionsShape decodes the documented `{ initialPath }` shape', () => {
    const decoded = Schema.decodeUnknownSync(NavigationBridge.Native.OptionsShape)({
      initialPath: '/gatekeeper',
    })
    expect(decoded).toEqual({ initialPath: '/gatekeeper' })
  })

  test('webOptionsShape accepts an empty object', () => {
    const decoded = Schema.decodeUnknownSync(NavigationBridge.Web.OptionsShape)({})
    expect(decoded).toEqual({})
  })

  test('Native makeSender encodes a NativeRequestedWebNavigation and the Web side decodes it', () => {
    const sent: string[] = []
    const send = NavigationBridge.Native.makeSender((encoded) =>
      Effect.sync(() => {
        sent.push(encoded)
      })
    )
    Effect.runSync(send({ _tag: 'NativeRequestedWebNavigation', path: '/foo' }))
    const decoded = Schema.decodeSync(
      NavigationBridge.Web.InboundSchemas.NativeRequestedWebNavigation
    )(sent[0])
    expect(decoded).toEqual({ _tag: 'NativeRequestedWebNavigation', path: '/foo' })
  })

  test('Web makeSender encodes a RouteChanged and the Native side decodes it', () => {
    const sent: string[] = []
    const send = NavigationBridge.Web.makeSender((encoded) =>
      Effect.sync(() => {
        sent.push(encoded)
      })
    )
    Effect.runSync(send({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true }))
    const decoded = Schema.decodeSync(NavigationBridge.Native.InboundSchemas.RouteChanged)(sent[0])
    expect(decoded).toEqual({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
  })
})
