import { emit, listen } from '@tauri-apps/api/event'
import type {
  Bridge,
  BridgeTransport,
  HandlerCoordinator,
} from '@wildflowerhealthio/effect-messaging-core'
import { PageDispatcher } from '@wildflowerhealthio/effect-messaging-core'
import { Effect } from 'effect'

import { BRIDGE_EVENT, READY_TAG } from './event-names.ts'

/**
 * The slice of Tauri's event API the transport consumes, structurally
 * narrowed so tests can inject a plain fake without reproducing
 * `@tauri-apps/api`'s generics. The real `emit`/`listen` satisfy it.
 */
interface TauriEventApi {
  readonly emit: (event: string, payload?: unknown) => Promise<void>
  readonly listen: (
    event: string,
    handler: (event: { readonly payload: unknown }) => void
  ) => Promise<() => void>
}

/**
 * Boot-stable handler seed, keyed by bridge name and typed per bridge —
 * the page dispatcher's {@link PageDispatcher.InitialHandlers}.
 */
type InitialHandlers<Bridges extends ReadonlyArray<Bridge.AnyBridge>> =
  PageDispatcher.InitialHandlers<Bridges>

/**
 * Config object accepted by {@link makeTauriTransport}.
 *
 * @typeParam Bridges - the wired bridge tuple this transport will serve.
 */
interface TauriTransportConfig<
  Bridges extends ReadonlyArray<Bridge.AnyBridge>,
> extends PageDispatcher.PageDispatcherConfig<Bridges> {
  /**
   * Injected event functions for tests; defaults to
   * `@tauri-apps/api/event`'s `emit`/`listen`.
   */
  readonly api?: TauriEventApi
}

/**
 * The Tauri-native bridge transport: the same `sendMessage` +
 * `coordinator` seam the React app consumes (`ReactTransport`), with no
 * string envelope underneath — every message rides the single
 * `BRIDGE_EVENT` Tauri event as a structured payload, with the
 * message's `_tag` field acting as the dispatch discriminator on the
 * receiving side.
 */
interface TauriTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * Emit an outbound (web→host) message on the single bridge channel.
   * Emit failures are logged and dropped — sending never fails the
   * caller, mirroring the core transport's outbound pump.
   */
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'WebToHost'>
  /**
   * Per-bridge inbound handler registration: last-writer-wins
   * `register`, set-if-equal `unregister`, drop-all-with-warn for
   * unregistered bridges — so slice `makeUseSliceRegister` hooks work
   * unchanged.
   */
  readonly coordinator: HandlerCoordinator
}

/**
 * Build the web-side bridge transport for a Tauri host.
 *
 * @remarks
 * The page-side dispatch (the `_tag` demux, `typeSchema` validation,
 * warn-and-drop, the single FIFO inbox fiber and the coordinator) is
 * {@link PageDispatcher.make}'s, which also rejects colliding or
 * reserved tags before any listener attaches. This transport adds the
 * Tauri glue: one `listen` on `BRIDGE_EVENT` feeding every payload to the
 * dispatcher, and `emit` on the same channel for outbound messages.
 *
 * Readiness: once the listener has attached, a `__Ready`-tagged payload
 * is emitted — only then may the host respond, so its first message
 * (e.g. the gatekeeper token) cannot race listener setup and vanish
 * (Tauri events are not buffered). The host re-receives `__Ready` on
 * every page load, so reloads re-trigger its boot-state push. The
 * resolved Promise therefore means the host has been told the page is
 * ready.
 *
 * The transport lives for the page's lifetime — the listener is never
 * detached (page teardown drops it with the document).
 *
 * @param config - see {@link TauriTransportConfig}.
 */
const makeTauriTransport = async <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  config: TauriTransportConfig<Bridges>
): Promise<TauriTransport<Bridges>> => {
  const { offer, coordinator } = PageDispatcher.make(config)
  const api = config.api ?? { emit, listen }

  const sendMessage: BridgeTransport.MessageSender<Bridges, 'WebToHost'> = (message) =>
    Effect.tryPromise(() => api.emit(BRIDGE_EVENT, message)).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(
          `[effect-messaging] tauri emit for ${message._tag} failed; message dropped: ${String(error)}`
        )
      ),
      Effect.asVoid
    )

  // One listener for the whole channel. The single listener is what pins
  // cross-tag FIFO — see `BRIDGE_EVENT`'s docstring.
  await api.listen(BRIDGE_EVENT, (event) => offer(event.payload))

  // The inbound listener is up — only now may the host learn we're
  // ready (its response could otherwise beat the listener and vanish).
  await api.emit(BRIDGE_EVENT, { _tag: READY_TAG })

  return { sendMessage, coordinator }
}

export { makeTauriTransport }
export type { InitialHandlers, TauriEventApi, TauriTransport, TauriTransportConfig }
