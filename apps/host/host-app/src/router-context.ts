import type { TauriTransport } from '@wildflowerhealthio/effect-messaging-tauri-js'
import type { RecorderBridge } from '@wildflowerhealthio/recorder-core-js'
import type { RecorderPageProps } from '@wildflowerhealthio/recorder-react'
import type { ServersRouterContext } from '@wildflowerhealthio/servers-react'

/** The bridge transport the Recorder runs over: `RecorderBridge` alone. */
type RecorderTransport = TauriTransport<readonly [RecorderBridge]>

/** How the Recorder's transport settled. */
type RecorderConnection =
  | { readonly _tag: 'Connected'; readonly transport: RecorderTransport }
  | { readonly _tag: 'Failed'; readonly error: unknown }

/**
 * `transport`, settled: `Connected` once it has told the host the page is
 * ready, `Failed` with why it couldn't. Never rejects.
 */
const settleRecorderTransport = (
  transport: Promise<RecorderTransport>
): Promise<RecorderConnection> =>
  transport.then(
    (connected): RecorderConnection => ({ _tag: 'Connected', transport: connected }),
    (error: unknown): RecorderConnection => ({ _tag: 'Failed', error })
  )

/**
 * What every route of the host reads from the router: the base's context,
 * which its routes read, and what the Recorder needs.
 */
interface RouterContext extends ServersRouterContext.RouterContext {
  /**
   * The Recorder's transport, settled: the root route's loader, so the host's
   * layout knows before it first renders whether the Recorder is connected.
   */
  readonly recorderConnection: Promise<RecorderConnection>
  /**
   * How the Recorder page reads its folder (Tauri's `invoke`) and shows a
   * saved file (`tauri-plugin-opener`'s `revealItemInDir`).
   */
  readonly recorderPage: RecorderPageProps
}

export { settleRecorderTransport }
export type { RecorderConnection, RecorderTransport, RouterContext }
