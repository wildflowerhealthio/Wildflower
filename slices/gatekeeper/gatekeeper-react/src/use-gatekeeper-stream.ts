import { type Scope, Stream } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useMemo } from 'react'
import { useStream } from 'react-kitchen-sink'

import { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'

/**
 * React Suspense-friendly runner for a `Stream` that requires
 * `GatekeeperHttpApiClient`. Auto-provides the slice's client layer,
 * the `BearerToken` (read from `<AuthTokenProvider>` higher up), and
 * `webHttpClientLayer`.
 */
const useGatekeeperStream = <A, E>(
  stream: Stream.Stream<A, E, GatekeeperHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useGatekeeperClientLayer()

  const provided = useMemo(
    () => stream.pipe(Stream.provideSomeLayer(clientLayer)),
    [stream, clientLayer]
  )

  return useStream(provided)
}

export { useGatekeeperStream }
