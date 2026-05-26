import { Effect, Layer } from 'effect'
import { TestPlatformAdapterLayer } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'
import { describe, expect, test } from 'vite-plus/test'
import { makeNavigationWebReceiverLayer } from './web-receiver-layer.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

describe('makeNavigationWebReceiverLayer', () => {
  test('HostBackRequested handler calls navigate(-1)', () => {
    const calls: Array<-1 | string> = []
    const layer = makeNavigationWebReceiverLayer((to) => calls.push(to))
    Effect.runSync(
      Effect.gen(function* () {
        const handlers = yield* NavigationBridge.Web.HandlerTag
        yield* handlers.HostBackRequested({ _tag: 'HostBackRequested' })
      }).pipe(Effect.provide(Layer.mergeAll(layer, adapterLayer)))
    )
    expect(calls).toEqual([-1])
  })

  test('HostRequestedWebNavigation handler calls navigate(path)', () => {
    const calls: Array<-1 | string> = []
    const layer = makeNavigationWebReceiverLayer((to) => calls.push(to))
    Effect.runSync(
      Effect.gen(function* () {
        const handlers = yield* NavigationBridge.Web.HandlerTag
        yield* handlers.HostRequestedWebNavigation({
          _tag: 'HostRequestedWebNavigation',
          path: '/visits/123',
        })
      }).pipe(Effect.provide(Layer.mergeAll(layer, adapterLayer)))
    )
    expect(calls).toEqual(['/visits/123'])
  })

  test('handlers route to the navigate function captured at layer-build time', () => {
    const callsA: Array<-1 | string> = []
    const callsB: Array<-1 | string> = []
    const layerA = makeNavigationWebReceiverLayer((to) => callsA.push(to))
    const layerB = makeNavigationWebReceiverLayer((to) => callsB.push(to))
    Effect.runSync(
      Effect.gen(function* () {
        const handlers = yield* NavigationBridge.Web.HandlerTag
        yield* handlers.HostBackRequested({ _tag: 'HostBackRequested' })
      }).pipe(Effect.provide(Layer.mergeAll(layerA, adapterLayer)))
    )
    Effect.runSync(
      Effect.gen(function* () {
        const handlers = yield* NavigationBridge.Web.HandlerTag
        yield* handlers.HostRequestedWebNavigation({
          _tag: 'HostRequestedWebNavigation',
          path: '/x',
        })
      }).pipe(Effect.provide(Layer.mergeAll(layerB, adapterLayer)))
    )
    expect(callsA).toEqual([-1])
    expect(callsB).toEqual(['/x'])
  })
})
