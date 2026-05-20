// @vitest-environment jsdom
// HttpApiClient builds requests with relative URLs (`'/fixture'`)
// against the helper's hardcoded `baseUrl: '/'`. Node's default URL
// parser rejects relative URLs without a base; jsdom provides
// `window.location.href` (`http://localhost/`) so resolution works.
// The package's other suites run on the Node default.
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpClient,
  HttpClientResponse,
} from '@effect/platform'
import { Effect, Layer, Schema, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import { describe, expect, test } from 'vite-plus/test'

import { defineSliceHttpClient } from './index.ts'

// ---------------------------------------------------------------------------
// Minimal fixture API: one GET endpoint returning a tiny body. Just
// enough surface to exercise the layer + the per-request bearer
// transformer.
// ---------------------------------------------------------------------------

const FixtureBody = Schema.Struct({ ok: Schema.Boolean })

const fixtureGroup = HttpApiGroup.make('fixture', { topLevel: false }).add(
  HttpApiEndpoint.get('GetFixture', '/fixture').addSuccess(FixtureBody)
)

const FixtureApi = HttpApi.make('FixtureApi').add(fixtureGroup)

// Stub HttpClient transport that records the outgoing `Authorization`
// header (or `undefined` if absent) into the supplied array and
// replies with the canned `FixtureBody`.
const capturingHttpClientLayer = (
  captures: Array<string | undefined>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      captures.push(request.headers['authorization'])
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    })
  )

describe('defineSliceHttpClient (authType: bearer)', () => {
  test('Tag.key matches the supplied name', () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureBearerClient',
      api: FixtureApi,
      authType: 'bearer',
    })
    class FixtureBearerClient extends sliceHc.ClientTag<FixtureBearerClient>() {}
    expect(FixtureBearerClient.key).toBe('FixtureBearerClient')
  })

  test('layer resolves to a usable client', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureBearerClient',
      api: FixtureApi,
      authType: 'bearer',
    })
    class FixtureBearerClient extends sliceHc.ClientTag<FixtureBearerClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureBearerClient)()
    }

    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))

    const program = Effect.gen(function* () {
      const client = yield* FixtureBearerClient
      return yield* client.fixture.GetFixture()
    })

    const layer = FixtureBearerClient.layer.pipe(
      Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
      Layer.provideMerge(capturingHttpClientLayer(captures))
    )

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
    expect(result).toEqual({ ok: true })
  })

  test('attaches Authorization: Bearer <token> when token is set', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureBearerClient',
      api: FixtureApi,
      authType: 'bearer',
    })
    class FixtureBearerClient extends sliceHc.ClientTag<FixtureBearerClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureBearerClient)()
    }

    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('alpha'))

    const program = Effect.gen(function* () {
      const client = yield* FixtureBearerClient
      yield* client.fixture.GetFixture()
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          FixtureBearerClient.layer.pipe(
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
            Layer.provideMerge(capturingHttpClientLayer(captures))
          )
        ),
        Effect.scoped
      )
    )

    expect(captures).toEqual(['Bearer alpha'])
  })

  test('omits Authorization when token is null', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureBearerClient',
      api: FixtureApi,
      authType: 'bearer',
    })
    class FixtureBearerClient extends sliceHc.ClientTag<FixtureBearerClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureBearerClient)()
    }

    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))

    const program = Effect.gen(function* () {
      const client = yield* FixtureBearerClient
      yield* client.fixture.GetFixture()
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          FixtureBearerClient.layer.pipe(
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
            Layer.provideMerge(capturingHttpClientLayer(captures))
          )
        ),
        Effect.scoped
      )
    )

    expect(captures).toEqual([undefined])
  })

  test('token rotation surfaces per request without rebuilding the layer', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureBearerClient',
      api: FixtureApi,
      authType: 'bearer',
    })
    class FixtureBearerClient extends sliceHc.ClientTag<FixtureBearerClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureBearerClient)()
    }

    const captures: Array<string | undefined> = []
    const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('alpha'))

    const program = Effect.gen(function* () {
      const client = yield* FixtureBearerClient
      yield* client.fixture.GetFixture()
      yield* SubscriptionRef.set(tokenRef, 'beta')
      yield* client.fixture.GetFixture()
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          FixtureBearerClient.layer.pipe(
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef)),
            Layer.provideMerge(capturingHttpClientLayer(captures))
          )
        ),
        Effect.scoped
      )
    )

    expect(captures).toEqual(['Bearer alpha', 'Bearer beta'])
  })

  test('records `authType: "bearer"` on the result for downstream wiring', () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureBearerClient',
      api: FixtureApi,
      authType: 'bearer',
    })
    expect(sliceHc.authType).toBe('bearer')
  })
})

describe('defineSliceHttpClient (authType: none)', () => {
  test('layer resolves to a usable client', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixturePublicClient',
      api: FixtureApi,
      authType: 'none',
    })
    class FixturePublicClient extends sliceHc.ClientTag<FixturePublicClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixturePublicClient)()
    }

    const captures: Array<string | undefined> = []

    const program = Effect.gen(function* () {
      const client = yield* FixturePublicClient
      return yield* client.fixture.GetFixture()
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          FixturePublicClient.layer.pipe(Layer.provideMerge(capturingHttpClientLayer(captures)))
        ),
        Effect.scoped
      )
    )
    expect(result).toEqual({ ok: true })
  })

  test('never attaches an Authorization header', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixturePublicClient',
      api: FixtureApi,
      authType: 'none',
    })
    class FixturePublicClient extends sliceHc.ClientTag<FixturePublicClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixturePublicClient)()
    }

    const captures: Array<string | undefined> = []

    const program = Effect.gen(function* () {
      const client = yield* FixturePublicClient
      yield* client.fixture.GetFixture()
      yield* client.fixture.GetFixture()
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          FixturePublicClient.layer.pipe(Layer.provideMerge(capturingHttpClientLayer(captures)))
        ),
        Effect.scoped
      )
    )

    expect(captures).toEqual([undefined, undefined])
  })

  test('layer type does not require BearerToken (type-level)', () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixturePublicClient',
      api: FixtureApi,
      authType: 'none',
    })
    class FixturePublicClient extends sliceHc.ClientTag<FixturePublicClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixturePublicClient)()
    }

    // Providing only `HttpClient` (no `BearerToken`) must satisfy the
    // public layer's requirements — if `authType: 'none'` accidentally
    // widened the layer to demand `BearerToken`, this would not compile.
    const provided: Layer.Layer<FixturePublicClient, never, never> = FixturePublicClient.layer.pipe(
      Layer.provideMerge(capturingHttpClientLayer([]))
    )
    expect(Layer.isLayer(provided)).toBe(true)

    // Inverse: assigning the public layer into a slot typed with only
    // `HttpClient.HttpClient` as a requirement compiles iff the layer
    // does NOT demand `BearerToken`.
    const publicLayerSlot: Layer.Layer<FixturePublicClient, never, HttpClient.HttpClient> =
      FixturePublicClient.layer
    expect(Layer.isLayer(publicLayerSlot)).toBe(true)
  })

  test('records `authType: "none"` on the result', () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixturePublicClient',
      api: FixtureApi,
      authType: 'none',
    })
    expect(sliceHc.authType).toBe('none')
  })
})

// `BearerToken` is the unique identity from `kitchen-sink/auth-token`
// that `react-kitchen-sink` re-exports. Two distinct class declarations
// with the same string Tag identifier resolve to the same runtime
// service but are nominally incompatible at the type layer — this
// helper catches a regression where `defineSliceHttpClient` grows a
// private `BearerToken` declaration of its own.
const acceptBearerToken = (token: BearerToken): BearerToken => token

describe('BearerToken identity', () => {
  test('helper consumes the `kitchen-sink/auth-token` BearerToken (type-level)', () => {
    expect(typeof acceptBearerToken).toBe('function')
  })
})
