import { Chunk, Effect, Encoding } from 'effect'
import { type TransportAdapter } from 'effect-messaging-core'
import * as TestPlatformAdapterLayer from 'effect-messaging-core/test'

import { type Step, ScrapingPlan } from 'collector-fundamentals/model'
import { SimpleResponseKind } from 'http-extraction-fundamentals/test-helpers'
import * as CollectorBridgeMessageHandler from './collector-bridge-message-handler.ts'
import type { SniffResult } from './sniffer-response-tracker.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

/**
 * Wrap `Effect.runSync` with a `TransportAdapter` discharge. Handlers
 * returned by `CollectorBridgeMessageHandler.make` declare R=TransportAdapter
 * (per `effect-messaging-core/src/message-handler.ts` widening); the live
 * dispatch fiber satisfies it for free, but isolated test calls have to
 * provide a stub. `TestPlatformAdapterLayer.make()` returns a valid layer
 * with a no-op `bareSender` — the handlers under test don't call it.
 */
const runHandlerSync = <A, E>(eff: Effect.Effect<A, E, TransportAdapter>): A =>
  Effect.runSync(Effect.provide(eff, adapterLayer))

const runHandlerPromise = <A, E>(eff: Effect.Effect<A, E, TransportAdapter>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, adapterLayer))

const encoder = new TextEncoder()

type SimpleResources = { name: string; age: number }
type SimpleHandlerArgs = Parameters<typeof CollectorBridgeMessageHandler.make<SimpleResources>>[0]

const noopSendMessage: SimpleHandlerArgs['sendMessage'] = () => Effect.void

/**
 * Build a handler bound to a single-entity plan (`SimpleResponseKind` only).
 * Most tests only care about one entity; the few that want overlapping or
 * multi-entity setups build the plan inline.
 */
const makeSimpleHandler = (
  overrides: Partial<SimpleHandlerArgs> & {
    readonly stepSequence?: readonly Step.Step[]
  } = {}
): Effect.Effect.Success<
  ReturnType<typeof CollectorBridgeMessageHandler.make<SimpleResources>>
> => {
  const { stepSequence, ...rest } = overrides
  return Effect.runSync(
    CollectorBridgeMessageHandler.make({
      scrapingPlan: ScrapingPlan.make<SimpleResources>({
        name: 'TestPlan',
        responseKinds: [SimpleResponseKind],
        stepSequence: stepSequence ?? [],
      }),
      sendMessage: noopSendMessage,
      runId: 'test-run',
      ...rest,
    })
  )
}

/**
 * Synchronously drain every {@link SniffResult} the handler has published so far.
 * The handlers run via `runHandlerSync` and `unsafeOffer` synchronously, so by
 * the time a handler call returns its result is already queued — this takes the
 * current contents without waiting. Uses `clear` (not `takeAll`, which blocks on
 * an empty mailbox) so a no-result path drains to `[]`. Replaces the old
 * `onResult` `vi.fn()` spy: assert on the returned array instead of mock calls.
 */
const drainResults = <TResources>(handler: {
  readonly requestSniffingResults: CollectorBridgeMessageHandler.CollectorBridgeMessageHandler<TResources>['requestSniffingResults']
}): ReadonlyArray<SniffResult<TResources>> =>
  Chunk.toReadonlyArray(Effect.runSync(handler.requestSniffingResults.clear))

type Handler = Effect.Effect.Success<
  ReturnType<typeof CollectorBridgeMessageHandler.make<SimpleResources>>
>
type StartArg = Parameters<Handler['ResponseStart']>[0]
type DataArg = Parameters<Handler['ResponseData']>[0]
type FinishArg = Parameters<Handler['ResponseFinished']>[0]
type ErrorArg = Parameters<Handler['RequestError']>[0]
type CancelledArg = Parameters<Handler['Cancelled']>[0]
type PageLoadedArg = Parameters<Handler['PageLoaded']>[0]
type UserDismissedArg = Parameters<Handler['UserDismissed']>[0]
type SnifferDisposedArg = Parameters<Handler['SnifferDisposed']>[0]

const responseStart = (overrides: { id: string; url: string }): StartArg => ({
  _tag: 'ResponseStart',
  status: 200,
  statusText: 'OK',
  headers: [],
  ...overrides,
})

const responseData = (id: string, body: string): DataArg => ({
  _tag: 'ResponseData',
  id,
  // The wire schema for `data` is a base64 `string` (see browser-sniffer-core
  // `ResponseDataMessage`); the handler decodes via `Encoding.decodeBase64`.
  data: Encoding.encodeBase64(encoder.encode(body)),
})

const responseFinished = (id: string): FinishArg => ({ _tag: 'ResponseFinished', id })

const requestError = (overrides: { id: string; url: string; message: string }): ErrorArg => ({
  _tag: 'RequestError',
  ...overrides,
})

const cancelled = (id: string): CancelledArg => ({ _tag: 'Cancelled', id })

const pageLoaded = (overrides: { url?: string; pageContentId?: string } = {}): PageLoadedArg => ({
  _tag: 'PageLoaded',
  url: overrides.url ?? 'https://example.com/',
  pageContentId: overrides.pageContentId ?? 'page-1',
})

const userDismissed = (): UserDismissedArg => ({ _tag: 'UserDismissed' })

const snifferDisposed = (): SnifferDisposedArg => ({ _tag: 'SnifferDisposed' })

/**
 * Let a forked `RequestCompletionCheck` daemon run to completion. It sleeps
 * nothing, so cooperative yields — not a clock tick — are what let it re-enter
 * the machine and drive `SniffingComplete`; bounded so a genuine hang still fails.
 */
const settleForkedWork: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 20; i += 1) {
    yield* Effect.yieldNow()
  }
})

export {
  adapterLayer,
  cancelled,
  drainResults,
  makeSimpleHandler,
  noopSendMessage,
  pageLoaded,
  requestError,
  responseData,
  responseFinished,
  responseStart,
  runHandlerPromise,
  runHandlerSync,
  settleForkedWork,
  snifferDisposed,
  userDismissed,
}
export type {
  CancelledArg,
  DataArg,
  ErrorArg,
  FinishArg,
  Handler,
  PageLoadedArg,
  SimpleHandlerArgs,
  SimpleResources,
  SnifferDisposedArg,
  StartArg,
  UserDismissedArg,
}
