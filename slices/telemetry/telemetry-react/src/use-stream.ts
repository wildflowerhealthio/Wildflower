import type { HttpClient } from '@effect/platform'
import { type Scope, Stream } from 'effect'
import { useMemo } from 'react'
import { useStream as useStreamCore } from 'react-kitchen-sink'

import { webHttpClientLayer } from './web-http-client-layer.ts'

/**
 * React Suspense-friendly Stream runner that auto-provides the
 * web-side {@link webHttpClientLayer}. Mirrors `react-kitchen-sink`'s
 * `useStream` shape, minus the `runtime` argument: callers feed a
 * stream whose remaining requirements are `HttpClient.HttpClient` (and
 * optionally `Scope.Scope`) and this hook supplies the HTTP client so
 * the underlying runner sees a context-free stream.
 *
 * Uses `Stream.provideSomeLayer` (not `provideLayer`) so the caller's
 * remaining R is `Exclude<R, HttpClient>` — preserves `Scope` and any
 * other requirements the caller hasn't pre-provided.
 */
const useStream = <A, E, R extends HttpClient.HttpClient | Scope.Scope = HttpClient.HttpClient>(
  stream: Stream.Stream<A, E, R>
): Promise<A> => {
  const provided = useMemo(() => Stream.provideSomeLayer(stream, webHttpClientLayer), [stream])
  return useStreamCore(provided)
}

export { useStream }
