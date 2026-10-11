import type * as Bridge from '../bridge.ts'
import { READY_TAG } from './handshake-message.ts'

/**
 * The direction-less tag guard for a page-side channel: every tag is owned
 * by exactly one bridge *and* one direction, and none shadows the reserved
 * `__Ready` handshake tag.
 *
 * @remarks
 * Tags discriminate dispatch on the single multiplexed channel that carries
 * both directions, so a tag in one bridge's `HostToWeb` and another's
 * `WebToHost` is ambiguous on the wire (on Tauri, events broadcast back to
 * the emitting webview, so the page would receive its own sends). Stricter
 * than the host transport's per-direction `assertNoDuplicateTags`. Throws
 * synchronously at build time, before any listener attaches.
 *
 * This check only sees the bridges it is handed. The channel is shared with
 * every other listener in the app (sibling TS transports, raw sniffer
 * webviews, each Rust host listener), and a colliding tag on a sibling
 * listener does NOT throw — both dispatch independently. When adding a tag,
 * grep the other listeners by hand; there is no automated cross-process
 * guard. See the effect-messaging-tauri-js README ("Tag uniqueness across
 * processes").
 */
const assertUniqueTags = (bridges: ReadonlyArray<Bridge.AnyBridge>): void => {
  const owners = new Map<string, string>([[READY_TAG, 'the reserved __Ready handshake tag']])
  for (const bridge of bridges) {
    for (const direction of ['HostToWeb', 'WebToHost'] as const) {
      for (const tag of Object.keys(bridge[direction])) {
        const owner = owners.get(tag)
        if (owner !== undefined) {
          throw new Error(
            `[effect-messaging] tag "${tag}" on bridge "${bridge.name}" (${direction}) collides with ${owner} — tags discriminate the multiplexed channel and must be unique across bridges and directions`
          )
        }
        owners.set(tag, `bridge "${bridge.name}" (${direction})`)
      }
    }
  }
}

export { assertUniqueTags }
