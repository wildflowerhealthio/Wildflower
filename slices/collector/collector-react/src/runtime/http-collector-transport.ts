/**
 * The HTTP transport behind the collector runtime: the replacement for the
 * retired Tauri `CollectorBridge` path. Outbound (web→host) messages map onto
 * the host's `/sniffer` REST endpoints; inbound (host→web) messages arrive on
 * the `/sniffer/events` WebSocket as the same tagged-JSON wire shapes the
 * bridge carried, decoded here with the very schemas `CollectorBridge`
 * declares — so the collector's handler machinery
 * (`CollectorBridgeMessageHandler`) is untouched by the transport swap.
 *
 * Because any HTTP client holding the right scopes can reach those endpoints
 * (the SPA on-device, or a browser reaching the phone through the tunnel),
 * this transport is what lets a web client drive the phone's collector.
 *
 * Design notes:
 *
 * - **Sender failures are logged, not raised.** `CollectorSender` is
 *   `(message) => Effect<void>` — the same fire-and-forget contract the
 *   bridge had — so the handler machinery's dispatch sites stay unchanged. A
 *   non-2xx (e.g. the 400 the host now answers for a rejected source) is
 *   surfaced in the log; the run then settles through its usual idle guard.
 * - **One socket, all tags, dispatch in arrival order.** The sniffer's
 *   cross-tag FIFO requirement (`ResponseData` chunks interleave with
 *   `ResponseStart`/`ResponseFinished`) is preserved by a single queue +
 *   sequential dispatch loop; per-tag fan-out would reorder the stream.
 * - **Register resolves once the socket is OPEN**, so the caller's
 *   register-before-dispatch ordering (connect the stream, then `POST
 *   /sniffer/webview`) holds — events can't slip between the open and the
 *   first dispatch.
 */
import { CollectorBridge } from 'collector-fundamentals/bridge'
import { Effect, Schema } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'

import type { CollectorOutboundMessage, CollectorSender } from './collector-sender-context.ts'

/** The handler record a run registers — one handler per host→web tag. */
type CollectorHandlers = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * The register/unregister pair the sync runner drives — structurally the
 * `SliceRegister<CollectorBridge>` shape the retired coordinator-backed hook
 * returned, so `sync-run.ts` is untouched.
 */
interface CollectorRegister {
  readonly register: (handlers: CollectorHandlers) => Effect.Effect<void>
  readonly unregister: (handlers: CollectorHandlers) => Effect.Effect<void>
}

/**
 * The one HTTP request a `CollectorOutboundMessage` maps to. Paths mirror the
 * `sniffer` group in `browser-sniffer-core/http-api-definition` (pinned
 * against the Rust server by that package's openapi-drift test).
 */
interface SnifferHttpRequest {
  readonly method: 'POST' | 'PUT' | 'DELETE'
  readonly path: string
  readonly body?: Record<string, unknown>
}

/**
 * Pure message→request mapping. `RequestSniffableWebView` and `Open` share
 * one endpoint deliberately: their host effect was identical under the
 * bridge (resolve the source, open-or-navigate), and the REST surface keeps
 * that equivalence explicit.
 */
const httpRequestForMessage = (message: CollectorOutboundMessage): SnifferHttpRequest => {
  switch (message._tag) {
    case 'RequestSniffableWebView':
      return {
        method: 'POST',
        path: '/sniffer/webview',
        body:
          message.linkedSpan === undefined
            ? { source: message.source }
            : { source: message.source, linkedSpan: message.linkedSpan },
      }
    case 'Open':
      return { method: 'POST', path: '/sniffer/webview', body: { source: message.source } }
    case 'SniffingComplete':
      return { method: 'DELETE', path: '/sniffer/webview' }
    case 'SetSnifferStatus':
      return { method: 'PUT', path: '/sniffer/status', body: { name: message.name } }
    case 'EnsureSnifferVisible':
      return { method: 'POST', path: '/sniffer/visibility' }
    case 'PageAction':
      return { method: 'POST', path: '/sniffer/page-actions', body: { action: message.action } }
    case 'CancelSnifferRequest':
      return { method: 'POST', path: '/sniffer/cancellations', body: { id: message.id } }
  }
  // `message` is `never` here — the switch is exhaustive over the bridge's
  // outbound union. The throw only satisfies control-flow analysis for a
  // caller that bypasses the types.
  throw new Error('http-collector-transport: unhandled collector outbound message')
}

/**
 * The `/sniffer/events` WebSocket URL for an API base. `apiBaseUrl` is the
 * absolute API origin when the page isn't served by the API server (the
 * Tauri webview); otherwise the page origin is the API origin.
 */
const eventsUrlFor = (apiBaseUrl: string | undefined, pageOrigin: string): string => {
  const base = apiBaseUrl ?? pageOrigin
  return `${base.replace(/^http/, 'ws')}/sniffer/events`
}

/**
 * What the transport needs from a WebSocket; the platform `WebSocket`
 * satisfies it (its `this`-annotated handler types widen to these). Kept as a
 * hand-written interface rather than `Pick<WebSocket, …>` so a test fake can
 * supply plain handlers without reconstructing WebSocket's `this` binding.
 */
interface EventSocket {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  close: () => void
}

/**
 * Injection points for tests (and non-browser hosts): the platform `fetch`
 * and `WebSocket` are the defaults.
 */
interface HttpCollectorTransportOptions {
  /** Absolute API origin; omitted when the page IS the API origin. */
  readonly apiBaseUrl?: string | undefined
  readonly fetchFn?: typeof fetch
  readonly createSocket?: (url: string) => EventSocket
  /** Page origin fallback for {@link eventsUrlFor}; defaults to `location.origin`. */
  readonly pageOrigin?: string
}

/** Read a message's `_tag` without decoding the whole payload. */
const peekTag = (raw: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && '_tag' in parsed) {
      const tag = (parsed as { readonly _tag: unknown })._tag
      return typeof tag === 'string' ? tag : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

type RawRoute = (raw: string) => Effect.Effect<void>

/** Decode a raw frame with `schema` and hand it to `handler`; a decode
 * failure is logged and dropped (the transport never takes a run down). */
const routeFor =
  <A>(
    schema: Schema.Schema<A, string, never>,
    handler: (message: A) => Effect.Effect<void>
  ): RawRoute =>
  (raw) =>
    Schema.decode(schema)(raw).pipe(
      Effect.flatMap(handler),
      Effect.catchAll((error) =>
        Effect.logWarning('http-collector-transport: undecodable event dropped', error)
      )
    )

/**
 * Tag→route table for a registered handler record — every host→web tag the
 * bridge declared, each decoded with its own schema. Explicit per-tag lines
 * (not a generic loop) so each schema/handler pair stays fully typed; the
 * exhaustiveness assertion below turns a newly added bridge tag into a
 * compile error here rather than a silently dropped stream.
 */
const dispatcherFor = (handlers: CollectorHandlers): ReadonlyMap<string, RawRoute> =>
  new Map<string, RawRoute>([
    ['ResponseStart', routeFor(CollectorBridge.HostToWeb.ResponseStart, handlers.ResponseStart)],
    ['ResponseData', routeFor(CollectorBridge.HostToWeb.ResponseData, handlers.ResponseData)],
    [
      'ResponseFinished',
      routeFor(CollectorBridge.HostToWeb.ResponseFinished, handlers.ResponseFinished),
    ],
    ['RequestError', routeFor(CollectorBridge.HostToWeb.RequestError, handlers.RequestError)],
    ['Cancelled', routeFor(CollectorBridge.HostToWeb.Cancelled, handlers.Cancelled)],
    ['PageLoaded', routeFor(CollectorBridge.HostToWeb.PageLoaded, handlers.PageLoaded)],
    ['UserDismissed', routeFor(CollectorBridge.HostToWeb.UserDismissed, handlers.UserDismissed)],
    [
      'SnifferDisposed',
      routeFor(CollectorBridge.HostToWeb.SnifferDisposed, handlers.SnifferDisposed),
    ],
  ])

/** Compile-time exhaustiveness: every host→web tag has a dispatcher line. */
type HandledTag =
  | 'ResponseStart'
  | 'ResponseData'
  | 'ResponseFinished'
  | 'RequestError'
  | 'Cancelled'
  | 'PageLoaded'
  | 'UserDismissed'
  | 'SnifferDisposed'
type UnhandledTag = Exclude<keyof CollectorBridge['HostToWeb'], HandledTag>
// A new bridge tag makes `UnhandledTag` non-`never`, failing this assignment.
const assertEveryHostToWebTagIsDispatched: [UnhandledTag] extends [never] ? 'ok' : never = 'ok'
void assertEveryHostToWebTagIsDispatched

/** One live `/sniffer/events` connection with its sequential dispatch pump. */
interface ActiveConnection {
  readonly socket: EventSocket
  close: () => void
}

/**
 * Build the collector's HTTP transport: the {@link CollectorSender} (REST)
 * and the {@link CollectorRegister} (WebSocket) over one `/sniffer` base.
 */
const makeHttpCollectorTransport = (
  options: HttpCollectorTransportOptions = {}
): { readonly sender: CollectorSender; readonly register: CollectorRegister } => {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const createSocket = options.createSocket ?? ((url: string): EventSocket => new WebSocket(url))
  const base = options.apiBaseUrl ?? ''

  const sender: CollectorSender = (message) =>
    Effect.gen(function* () {
      const { method, path, body } = httpRequestForMessage(message)
      const response = yield* Effect.tryPromise(() =>
        fetchFn(`${base}${path}`, {
          method,
          // The `wf_auth` cookie must ride the Tauri webview's cross-origin
          // loopback fetches, matching the app-wide credentialed fetch layer.
          credentials: 'include',
          ...(body === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }),
        })
      )
      if (!response.ok) {
        yield* Effect.logWarning(
          `http-collector-transport: ${method} ${path} answered ${response.status} for ${message._tag}`
        )
      }
    }).pipe(
      // Fire-and-forget contract (see module docs): a transport failure is
      // logged and the run settles via its idle guard, as under the bridge.
      Effect.catchAll((error) =>
        Effect.logWarning(`http-collector-transport: dispatch of ${message._tag} failed`, error)
      )
    )

  let active: ActiveConnection | null = null

  const register = (handlers: CollectorHandlers): Effect.Effect<void> =>
    Effect.async<void>((resume) => {
      // One run at a time drives the sniffer; a stray earlier connection
      // (e.g. a run torn down without its release) is replaced, not stacked.
      active?.close()

      const routes = dispatcherFor(handlers)
      const queue: string[] = []
      let draining = false
      // A field, not a bare `let`, so the drain loop's condition reads a member
      // expression `connectionState.closed` — a plain `!closed` trips
      // `no-unmodified-loop-condition` (the flag is flipped in a sibling closure).
      const connectionState = { closed: false }
      let resumed = false

      const resumeOnce = (): void => {
        if (!resumed) {
          resumed = true
          resume(Effect.void)
        }
      }

      const dispatch = async (raw: string): Promise<void> => {
        const tag = peekTag(raw)
        const route = tag === undefined ? undefined : routes.get(tag)
        if (route === undefined) {
          // Tags outside the handler record — the page's `Log` console-shim
          // stream, or future additions — are dropped, mirroring the bridge
          // transport's log-and-drop for unhandled tags.
          return
        }
        await Effect.runPromise(route(raw))
      }

      const drain = async (): Promise<void> => {
        if (draining) return
        draining = true
        try {
          // Strictly sequential: the next frame is dispatched only after the
          // previous handler's Effect settles — the FIFO the tracker needs.
          while (queue.length > 0 && !connectionState.closed) {
            const raw = queue.shift()
            // oxlint-disable-next-line no-await-in-loop -- sequential by design; parallel dispatch would reorder the stream
            if (raw !== undefined) await dispatch(raw)
          }
        } finally {
          draining = false
        }
      }

      const socket = createSocket(eventsUrlFor(options.apiBaseUrl, pageOriginOf(options)))
      const connection: ActiveConnection = {
        socket,
        close: () => {
          connectionState.closed = true
          socket.close()
        },
      }
      active = connection

      // A sniffer webview has exactly one owner (this run's connection), so
      // single-handler replacement semantics are precisely what we want —
      // `addEventListener`'s multi-listener support would be a foot-gun here
      // (a leaked prior handler would double-dispatch the stream).
      /* oxlint-disable unicorn/prefer-add-event-listener */
      socket.onopen = () => resumeOnce()
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          queue.push(event.data)
          void drain()
        }
      }
      socket.onerror = () => {
        // Resolve rather than fail: register's caller treats a registration
        // problem as non-fatal (the run then ends through its idle guard),
        // and an error after open is just a dead stream.
        // oxlint-disable-next-line no-console
        console.warn('http-collector-transport: /sniffer/events socket errored')
        resumeOnce()
      }
      socket.onclose = () => {
        resumeOnce()
        if (active === connection) active = null
      }
      /* oxlint-enable unicorn/prefer-add-event-listener */

      return Effect.sync(() => {
        // Interruption of the register itself (not the run) — drop the socket.
        connection.close()
      })
    })

  const unregister = (_handlers: CollectorHandlers): Effect.Effect<void> =>
    Effect.sync(() => {
      active?.close()
      active = null
    })

  return { sender, register: { register, unregister } }
}

const pageOriginOf = (options: HttpCollectorTransportOptions): string =>
  options.pageOrigin ?? globalThis.location.origin

export { eventsUrlFor, httpRequestForMessage, makeHttpCollectorTransport }
export type {
  CollectorHandlers,
  CollectorRegister,
  EventSocket,
  HttpCollectorTransportOptions,
  SnifferHttpRequest,
}
