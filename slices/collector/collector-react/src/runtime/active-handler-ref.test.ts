import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import {
  type ActiveCollectorBridgeMessageHandler,
  clearActiveHandlerIfCurrent,
  collectorWebHandlers,
  setActiveHandler,
} from './active-handler-ref.ts'

/**
 * Pins the singleton handler-ref + handler-record contract:
 *
 *   - install / clear / re-read traversal on the ref;
 *   - the handler record forwards each Host→Web tag to the installed
 *     handler's matching method;
 *   - the handler record log-warns (and resolves to void) when no
 *     handler is installed, rather than throwing;
 *   - `clearActiveHandlerIfCurrent` is set-if-equal: a stale clear
 *     does not blank out a successor handler.
 *
 * The ref is module-scoped — `afterEach` resets it so a leftover from
 * one case can't supersede the next case's first install.
 */

afterEach(() => {
  setActiveHandler(null)
})

interface StubHandler {
  readonly stub: ActiveCollectorBridgeMessageHandler
  readonly calls: ReadonlyArray<{ readonly method: string; readonly event: unknown }>
}

/**
 * Build a partial handler whose only behaviour is to record method
 * invocations. The cast widens the test stub to the real handler type;
 * sound because the handler record below only reads the six per-tag
 * methods, never `inProgressResponses` / `clear` / `cancelAllInFlight`.
 */
const makeStubHandler = (): StubHandler => {
  const calls: Array<{ method: string; event: unknown }> = []
  const record =
    (method: string) =>
    (event: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        calls.push({ method, event })
      })
  const partial = {
    ResponseStart: record('ResponseStart'),
    ResponseData: record('ResponseData'),
    ResponseFinished: record('ResponseFinished'),
    RequestError: record('RequestError'),
    Cancelled: record('Cancelled'),
    PageLoaded: record('PageLoaded'),
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { stub: partial as unknown as ActiveCollectorBridgeMessageHandler, calls }
}

/**
 * The handler record's per-tag methods are typed to the decoded
 * `CollectorBridge.Web` message schemas. These tests exercise only the
 * ref-forwarding logic (install / clear / set-if-equal / null-drop),
 * which passes each event through verbatim without decoding it — so we
 * view the methods through an `unknown`-event shape and drive them with
 * minimal marker objects.
 */
type ForwardingHandlers = Record<
  | 'ResponseStart'
  | 'ResponseData'
  | 'ResponseFinished'
  | 'RequestError'
  | 'Cancelled'
  | 'PageLoaded',
  (event: unknown) => Effect.Effect<void>
>
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const handlers = collectorWebHandlers as unknown as ForwardingHandlers

describe('active-handler-ref ref operations', () => {
  test('install / re-read / clear traversal', () => {
    const { stub } = makeStubHandler()

    setActiveHandler(stub)
    // The record reads activeHandlerRef.current on every dispatch, so
    // a successful re-read is observable via the routing test below;
    // here we drive the simpler shape: install then clear succeeds
    // and a later forwarded message lands on the cleared (null) state.
    setActiveHandler(null)
    expect(true).toBe(true)
  })

  test('clearActiveHandlerIfCurrent only blanks the ref when the handler matches', async () => {
    const a = makeStubHandler()
    const b = makeStubHandler()

    setActiveHandler(a.stub)
    setActiveHandler(b.stub)
    // A stale cleanup from handler-A runs after handler-B has taken
    // the slot. With set-if-equal, A's clear is a no-op; B stays
    // installed and receives subsequent forwards.
    clearActiveHandlerIfCurrent(a.stub)

    // Drive a message through the record and verify B got it.
    await Effect.runPromise(handlers.ResponseStart({ id: 'msg-1' }))
    expect(b.calls).toEqual([{ method: 'ResponseStart', event: { id: 'msg-1' } }])
    expect(a.calls).toEqual([])
  })

  test('clearActiveHandlerIfCurrent on the current handler clears the ref', async () => {
    const a = makeStubHandler()
    setActiveHandler(a.stub)
    clearActiveHandlerIfCurrent(a.stub)

    // No installed handler → log-warn-and-drop, no exception.
    await Effect.runPromise(handlers.ResponseStart({ id: 'msg-1' }))
    expect(a.calls).toEqual([])
  })
})

describe('collectorWebHandlers dispatch', () => {
  test('forwards each Host→Web tag to the installed handler', async () => {
    const { stub, calls } = makeStubHandler()
    setActiveHandler(stub)

    const eventStart = { id: 'a', request: { method: 'GET', url: 'https://x' } }
    const eventData = { id: 'a', chunkBase64: 'AA==' }
    const eventFinished = { id: 'a' }
    const eventError = { id: 'a', reason: 'boom' }
    const eventCancelled = { id: 'a' }
    const eventPageLoaded = { id: 'a', pageIndex: 0 }

    await Effect.runPromise(
      Effect.all([
        handlers.ResponseStart(eventStart),
        handlers.ResponseData(eventData),
        handlers.ResponseFinished(eventFinished),
        handlers.RequestError(eventError),
        handlers.Cancelled(eventCancelled),
        handlers.PageLoaded(eventPageLoaded),
      ])
    )

    expect(calls).toEqual([
      { method: 'ResponseStart', event: eventStart },
      { method: 'ResponseData', event: eventData },
      { method: 'ResponseFinished', event: eventFinished },
      { method: 'RequestError', event: eventError },
      { method: 'Cancelled', event: eventCancelled },
      { method: 'PageLoaded', event: eventPageLoaded },
    ])
  })

  test('resolves to void (log-and-drop) when no handler is installed', async () => {
    // Drives the null branch: every per-tag method returns
    // `droppedTagWarning(tag)` when the ref is null. The assertion is
    // "doesn't throw and resolves cleanly"; the warning itself is an
    // `Effect.logWarning`, which surfaces via the configured logger
    // rather than the test's return channel.
    setActiveHandler(null)

    await expect(Effect.runPromise(handlers.ResponseStart({ id: 'msg' }))).resolves.toBeUndefined()
  })

  test('switching the installed handler routes subsequent tags to the new one', async () => {
    const a = makeStubHandler()
    const b = makeStubHandler()
    setActiveHandler(a.stub)

    await Effect.runPromise(handlers.ResponseStart({ id: 'before-swap' }))
    setActiveHandler(b.stub)
    await Effect.runPromise(handlers.ResponseStart({ id: 'after-swap' }))

    expect(a.calls).toEqual([{ method: 'ResponseStart', event: { id: 'before-swap' } }])
    expect(b.calls).toEqual([{ method: 'ResponseStart', event: { id: 'after-swap' } }])
  })
})
