import { Effect } from 'effect'

/**
 * Capture the span context (`traceId` + `spanId`) of the trace active on
 * the current fiber, for threading into
 * `RequestSniffableWebView.linkedSpan` so the host can span-link the
 * sniffer's root spans back to it.
 *
 * Succeeds with `undefined` when no span is in scope — `Effect.currentSpan`
 * fails with `NoSuchElementException` there, which we recover to `undefined`
 * so callers attach the field only when a real context exists. A send fired
 * outside any `Effect.withSpan` (e.g. a bare `Effect.runPromise` off a click
 * handler) therefore carries no link, rather than a bogus one.
 */
const captureLinkedSpan: Effect.Effect<
  { readonly traceId: string; readonly spanId: string } | undefined
> = Effect.currentSpan.pipe(
  Effect.map((span) => ({ traceId: span.traceId, spanId: span.spanId })),
  Effect.orElseSucceed(() => undefined)
)

export { captureLinkedSpan }
