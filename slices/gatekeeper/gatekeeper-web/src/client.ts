import { FetchHttpClient, HttpApiClient } from '@effect/platform'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { AuthApi } from 'gatekeeper-core/http-api-definition'
import { webTelemetryLayerFromEnv } from 'telemetry-web'

const runtime = ManagedRuntime.make(
  Layer.mergeAll(FetchHttpClient.layer, webTelemetryLayerFromEnv())
)

const authClientPromise = runtime.runPromise(
  Effect.orDie(HttpApiClient.make(AuthApi, { baseUrl: '/' }))
)

type AuthClient = Awaited<typeof authClientPromise>

type RuntimeEnv = ManagedRuntime.ManagedRuntime.Context<typeof runtime>

const runAuth = async <A, E>(
  f: (client: AuthClient) => Effect.Effect<A, E, RuntimeEnv>
): Promise<A> => {
  const client = await authClientPromise
  return runtime.runPromise(f(client))
}

export { runAuth }
export type { AuthClient }
