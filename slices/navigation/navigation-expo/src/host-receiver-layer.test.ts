import type { Effect, Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import { NavigationBridgeExpo } from './index.ts'

describe('NavigationBridgeExpo.ReceiverLayer', () => {
  it('returns a Layer providing the Navigation host handler tag', () => {
    expectTypeOf(NavigationBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>>
    >()
  })

  it('accepts an optional onRouteChanged callback', () => {
    expectTypeOf(NavigationBridgeExpo.ReceiverLayer)
      .parameter(0)
      .toEqualTypeOf<((route: { pathname: string; canGoBack: boolean }) => void) | undefined>()
  })

  it('accepts an optional onLog callback returning an Effect', () => {
    expectTypeOf(NavigationBridgeExpo.ReceiverLayer)
      .parameter(1)
      .toEqualTypeOf<((log: string) => Effect.Effect<void>) | undefined>()
  })
})
