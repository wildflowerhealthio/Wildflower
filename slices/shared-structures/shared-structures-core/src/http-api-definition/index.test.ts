// @vitest-environment jsdom
// HttpApiClient builds requests with relative URLs (`'/fixture'` —
// the helper passes no `baseUrl`). Node's default URL parser rejects
// relative URLs without a base; jsdom provides `window.location.href`
// (`http://localhost/`) so resolution works. The package's other
// suites run on the Node default.
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from '@effect/platform'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { defineSliceHttpClient } from './index.ts'

// ---------------------------------------------------------------------------
// Minimal fixture API: one GET endpoint returning a tiny body. Just
// enough surface to exercise the tokenless layer.
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

describe('defineSliceHttpClient', () => {
  test('Tag.key matches the supplied name', () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureClient',
      api: FixtureApi,
    })
    class FixtureClient extends sliceHc.ClientTag<FixtureClient>() {}
    expect(FixtureClient.key).toBe('FixtureClient')
  })

  test('layer resolves to a usable client', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureClient',
      api: FixtureApi,
    })
    class FixtureClient extends sliceHc.ClientTag<FixtureClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureClient)()
    }

    const captures: Array<string | undefined> = []

    const program = Effect.gen(function* () {
      const client = yield* FixtureClient
      return yield* client.fixture.GetFixture()
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          FixtureClient.layer.pipe(Layer.provideMerge(capturingHttpClientLayer(captures)))
        ),
        Effect.scoped
      )
    )
    expect(result).toEqual({ ok: true })
  })

  test('never attaches an Authorization header (cookie auth)', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureClient',
      api: FixtureApi,
    })
    class FixtureClient extends sliceHc.ClientTag<FixtureClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureClient)()
    }

    const captures: Array<string | undefined> = []

    const program = Effect.gen(function* () {
      const client = yield* FixtureClient
      yield* client.fixture.GetFixture()
      yield* client.fixture.GetFixture()
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(
          FixtureClient.layer.pipe(Layer.provideMerge(capturingHttpClientLayer(captures)))
        ),
        Effect.scoped
      )
    )

    expect(captures).toEqual([undefined, undefined])
  })

  test('layer requires only HttpClient (type-level)', () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureClient',
      api: FixtureApi,
    })
    class FixtureClient extends sliceHc.ClientTag<FixtureClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureClient)()
    }

    // Providing only `HttpClient` must fully satisfy the layer's
    // requirements — if the helper grew an extra requirement (e.g. a
    // token service), this would not compile.
    const provided: Layer.Layer<FixtureClient, never, never> = FixtureClient.layer.pipe(
      Layer.provideMerge(capturingHttpClientLayer([]))
    )
    expect(Layer.isLayer(provided)).toBe(true)

    // Inverse: assigning the layer into a slot typed with only
    // `HttpClient.HttpClient` as a requirement compiles iff the layer
    // demands nothing more.
    const httpOnlySlot: Layer.Layer<FixtureClient, never, HttpClient.HttpClient> =
      FixtureClient.layer
    expect(Layer.isLayer(httpOnlySlot)).toBe(true)
  })
})

// Stub HttpClient transport that records each outgoing request URL and
// replies with the canned `FixtureBody`.
const urlCapturingHttpClientLayer = (urls: string[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      urls.push(request.url)
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

describe('defineSliceHttpClient (request URLs)', () => {
  test('requests carry the endpoint path verbatim', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureClient',
      api: FixtureApi,
    })
    class FixtureClient extends sliceHc.ClientTag<FixtureClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureClient)()
    }

    const urls: string[] = []

    await Effect.runPromise(
      Effect.flatMap(FixtureClient, (client) => client.fixture.GetFixture()).pipe(
        Effect.provide(
          FixtureClient.layer.pipe(Layer.provideMerge(urlCapturingHttpClientLayer(urls)))
        ),
        Effect.scoped
      )
    )

    expect(urls).toEqual(['/fixture'])
  })

  // Regression: the helper used to pass `baseUrl: '/'`, and
  // `HttpApiClient`'s base prepend runs *after* transforms the app
  // layered onto the context `HttpClient` — an app-level origin
  // prepend (the Tauri entry's `apiBaseUrl`) produced
  // `/http://127.0.0.1:8080/fixture`, which fetch then resolved
  // against the page origin.
  test('composes with an app-level origin prepend into an absolute URL', async () => {
    const sliceHc = defineSliceHttpClient({
      name: 'FixtureClient',
      api: FixtureApi,
    })
    class FixtureClient extends sliceHc.ClientTag<FixtureClient>() {
      static readonly layer = sliceHc.makeLayerFactory(FixtureClient)()
    }

    const urls: string[] = []
    const prependingClientLayer = Layer.effect(
      HttpClient.HttpClient,
      Effect.map(
        HttpClient.HttpClient,
        HttpClient.mapRequest(HttpClientRequest.prependUrl('http://127.0.0.1:8080'))
      )
    ).pipe(Layer.provide(urlCapturingHttpClientLayer(urls)))

    await Effect.runPromise(
      Effect.flatMap(FixtureClient, (client) => client.fixture.GetFixture()).pipe(
        Effect.provide(FixtureClient.layer.pipe(Layer.provideMerge(prependingClientLayer))),
        Effect.scoped
      )
    )

    expect(urls).toEqual(['http://127.0.0.1:8080/fixture'])
  })
})
