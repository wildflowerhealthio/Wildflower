// @vitest-environment jsdom
// `webApiOriginLocationLayer` reads `window.location.origin`; jsdom
// supplies it (`http://localhost`).
import { Effect, Stream } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { WebApiOrigin } from 'shared-structures-core/web-api-origin'

import { makeWebApiOriginBridgeStore, webApiOriginLocationLayer } from './web-api-origin.ts'

describe('webApiOriginLocationLayer', () => {
  test('get yields window.location.origin', async () => {
    const result = await Effect.runPromise(
      WebApiOrigin.get.pipe(Effect.provide(webApiOriginLocationLayer))
    )
    expect(result).toBe(window.location.origin)
  })
})

describe('makeWebApiOriginBridgeStore', () => {
  test('get yields the seeded origin', async () => {
    const store = makeWebApiOriginBridgeStore('http://127.0.0.1:8080')
    const result = await Effect.runPromise(WebApiOrigin.get.pipe(Effect.provide(store.layer)))
    expect(result).toBe('http://127.0.0.1:8080')
  })

  test('set re-points the origin surfaced by a later get', async () => {
    const store = makeWebApiOriginBridgeStore('http://first.example')
    const before = await Effect.runPromise(WebApiOrigin.get.pipe(Effect.provide(store.layer)))
    store.set('http://second.example')
    const after = await Effect.runPromise(WebApiOrigin.get.pipe(Effect.provide(store.layer)))
    expect(before).toBe('http://first.example')
    expect(after).toBe('http://second.example')
  })

  test('changes reflects the latest origin after set', async () => {
    const store = makeWebApiOriginBridgeStore('http://first.example')
    store.set('http://second.example')
    // `take(1)` grabs the SubscriptionRef's current value on subscribe —
    // no fork, so no race between the set above and the subscription.
    const latest = await Effect.runPromise(
      WebApiOrigin.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(store.layer)
      )
    )
    expect(latest).toEqual(['http://second.example'])
  })
})
