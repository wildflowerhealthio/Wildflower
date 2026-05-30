import { HttpClient, HttpClientResponse } from '@effect/platform'
import { renderHook } from '@testing-library/react'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { BearerToken } from 'kitchen-sink/auth-token'
import { describe, expect, test, vi } from 'vite-plus/test'

import {
  sliceRuntimeLayer,
  useFhirR4ResourcesRuntimeLayer,
  type RuntimeLayer,
} from './router-context.ts'

/**
 * Pins the imperative-runner seam fhir-r4-react exposes for
 * `collector-react`'s `useSyncRunner`: a per-bridge-message, retried PUT
 * is NOT a one-shot query, so it reads the composed `runtimeLayer` from
 * router context (`useFhirR4ResourcesRuntimeLayer`), `Effect.provide`s it
 * onto a `FhirR4ResourcesHttpApiClient` call, and runs it itself —
 * exactly how `useSyncRunner` upserts each parsed resource.
 *
 * The exercised call here is `Patient.SearchByGet` (a GET) rather than
 * the `Update` (PUT) `useSyncRunner` actually fires: the runner wiring
 * under test — read the layer from context, provide it, run it as a
 * Promise, surface failures — is identical for either verb, and the GET
 * avoids constructing a full FHIR `Patient` request body that the PUT
 * payload schema requires. The decode of the canned bundle is itself
 * covered by `patients.test.ts`.
 *
 * The hook reads `runtimeLayer` via `useRouteContext({ from: '__root__',
 * select })`. fhir-r4-react has no router of its own, so rather than
 * mount one we mock `useRouteContext` to feed a layer through its
 * `select` — the same harness shape gatekeeper-react's mutation tests
 * use. Each test installs the layer it wants via the module-level
 * `layerHolder` ref (the `vi.mock` factory is hoisted, so it reads the
 * ref lazily at render time). The transport is a stub HttpClient, so the
 * round-trip runs offline.
 */

// Builds the composed `runtimeLayer` the app would provide: the slice
// client layer over `BearerToken | HttpClient`, with a stub transport.
const buildRuntimeLayer = (options?: { readonly failing?: boolean }): RuntimeLayer => {
  const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('token'))
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          options?.failing === true
            ? new Response(null, { status: 500 })
            : new Response(
                JSON.stringify({
                  resourceType: 'Bundle',
                  type: 'searchset',
                  entry: [{ resource: { resourceType: 'Patient', id: 'pat-1' } }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
              )
        )
      )
    )
  )
  return pipe(
    sliceRuntimeLayer,
    Layer.provideMerge(httpLayer),
    Layer.provideMerge(Layer.succeed(BearerToken, tokenRef))
  )
}

// Mutable holder the (hoisted) `useRouteContext` mock reads at render
// time. `vi.hoisted` lifts it above the `vi.mock` factory.
const layerHolder = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@tanstack/react-router', () => ({
  useRouteContext: ({
    select,
  }: {
    select: (context: { runtimeLayer: unknown }) => unknown
  }): unknown => select({ runtimeLayer: layerHolder.current }),
}))

describe('useFhirR4ResourcesRuntimeLayer', () => {
  test('returns the runtimeLayer from router context', () => {
    const layer = buildRuntimeLayer()
    layerHolder.current = layer

    const { result } = renderHook(() => useFhirR4ResourcesRuntimeLayer())

    expect(result.current).toBe(layer)
  })

  test('the imperative seam resolves a FhirR4ResourcesHttpApiClient call against the layer', async () => {
    const layer = buildRuntimeLayer()
    layerHolder.current = layer

    const { result } = renderHook(() => useFhirR4ResourcesRuntimeLayer())
    const runtimeLayer = result.current

    // Exactly the `useSyncRunner` shape: provide the layer onto a
    // `FhirR4ResourcesHttpApiClient` call and run it as a Promise.
    const bundle = await Effect.runPromise(
      Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) =>
        client.Patient.SearchByGet({ urlParams: {} })
      ).pipe(Effect.provide(runtimeLayer))
    )

    expect(bundle.entry?.[0]?.resource?.id).toBe('pat-1')
  })

  test('a failed call rejects (surfaces to the imperative runner for retry/onError)', async () => {
    const layer = buildRuntimeLayer({ failing: true })
    layerHolder.current = layer

    const { result } = renderHook(() => useFhirR4ResourcesRuntimeLayer())
    const runtimeLayer = result.current

    await expect(
      Effect.runPromise(
        Effect.flatMap(FhirR4ResourcesHttpApiClient, (client) =>
          client.Patient.SearchByGet({ urlParams: {} })
        ).pipe(Effect.provide(runtimeLayer))
      )
    ).rejects.toThrow()
  })
})
