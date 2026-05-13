import type { CollectorHttpApiClient } from 'collector-core/clients'
import { type Scope, Stream } from 'effect'
import { useMemo } from 'react'
import { useStream } from 'react-kitchen-sink'

import { useCollectorClientLayer } from './use-collector-client-layer.ts'

/**
 * React Suspense-friendly runner for a `Stream` that requires
 * `CollectorHttpApiClient`. Auto-provides the slice's client layer,
 * the `BearerToken` (read from `<AuthTokenProvider>` higher up), and
 * `webHttpClientLayer`.
 */
const useCollectorStream = <A, E>(
  stream: Stream.Stream<A, E, CollectorHttpApiClient | Scope.Scope>
): Promise<A> => {
  const clientLayer = useCollectorClientLayer()

  const provided = useMemo(
    () => stream.pipe(Stream.provideSomeLayer(clientLayer)),
    [stream, clientLayer]
  )

  return useStream(provided)
}

export { useCollectorStream }
