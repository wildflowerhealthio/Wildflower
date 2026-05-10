import { Effect } from 'effect'
import type { TransportAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'

/**
 * Page-side transport setup. The `WebPlatformAdapter`-built `drainInitial`
 * reads `?msg.<Tag>=...` URL params synchronously (and strips them so a
 * Fast Refresh / HMR cycle does not re-dispatch them); the captured
 * encoded strings are exposed as {@link initialMessages} so
 * `find-initial-path` can seed `<MemoryRouter initialEntries>` without
 * standing up the transport, and as a {@link replayAdapter} the
 * React-mounted transport consumes via `BridgeTransport.make`.
 */
const webAdapter = WebPlatformAdapter.make()
const initialMessages: ReadonlyArray<string> = Effect.runSync(webAdapter.drainInitial)

const replayAdapter: TransportAdapter['Type'] = {
  bareSender: webAdapter.bareSender,
  drainInitial: Effect.succeed(initialMessages),
  attachLive: webAdapter.attachLive,
}

export { initialMessages, replayAdapter }
