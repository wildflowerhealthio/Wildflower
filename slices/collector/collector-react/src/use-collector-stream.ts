import type { CollectorHttpApiClient } from 'collector-core/clients'
import type { Scope, Stream } from 'effect'
import { useStream } from 'react-kitchen-sink'

import { useCollectorClientLayer } from './use-collector-client-layer.ts'

/**
 * Thin wrapper around `useStream` that supplies the slice's full
 * client layer (`CollectorHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). The screen just constructs the Stream; the
 * shared kitchen-sink hook handles subscription, scope, and lifecycle.
 */
const useCollectorStream = <A, E>(
  stream: Stream.Stream<A, E, CollectorHttpApiClient | Scope.Scope>
): Promise<A> => useStream(stream, useCollectorClientLayer())

export { useCollectorStream }
