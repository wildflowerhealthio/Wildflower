import { FetchHttpClient, HttpApiClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import { webTelemetryLayerFromEnv } from 'telemetry-web'

const TOKEN_STORAGE_KEY = 'gatekeeper:token'

const readToken = (): string | null => {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_STORAGE_KEY)
}

const writeToken = (token: string): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
}

const runtime = ManagedRuntime.make(
  Layer.mergeAll(FetchHttpClient.layer, webTelemetryLayerFromEnv())
)

const clientPromise = runtime.runPromise(
  Effect.orDie(
    HttpApiClient.make(GatekeeperApi, {
      baseUrl: '/',
      transformClient: (client) =>
        HttpClient.mapRequest(client, (request) => {
          const token = readToken()
          if (token === null) return request
          return HttpClientRequest.setHeader(request, 'Authorization', `Bearer ${token}`)
        }),
    })
  )
)

type GatekeeperClient = Awaited<typeof clientPromise>

type RuntimeEnv = ManagedRuntime.ManagedRuntime.Context<typeof runtime>

const runAuth = async <A, E>(
  f: (client: GatekeeperClient) => Effect.Effect<A, E, RuntimeEnv>
): Promise<A> => {
  const client = await clientPromise
  return runtime.runPromise(f(client))
}

export { runAuth, readToken, writeToken, TOKEN_STORAGE_KEY }
export type { GatekeeperClient }
