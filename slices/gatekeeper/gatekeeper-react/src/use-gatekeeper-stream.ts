import type { Scope, Stream } from 'effect'
import type { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useStream } from 'react-kitchen-sink'

import { useGatekeeperClientLayer } from './use-gatekeeper-client-layer.ts'

/**
 * Thin wrapper around `useStream` that supplies the slice's full
 * client layer (`GatekeeperHttpApiClient` + `BearerToken` +
 * `webHttpClientLayer`). The screen just constructs the Stream; the
 * shared kitchen-sink hook handles subscription, scope, and lifecycle.
 */
const useGatekeeperStream = <A, E>(
  stream: Stream.Stream<A, E, GatekeeperHttpApiClient | Scope.Scope>
): Promise<A> => useStream(stream, useGatekeeperClientLayer())

export { useGatekeeperStream }
