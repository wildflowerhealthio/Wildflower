import { Array, type Effect, Option } from 'effect'
import type * as Bridge from '../bridge.ts'
import type * as Message from '../message.ts'
import type { TransportAdapter } from '../transport-adapter.ts'

/**
 * Erased shape of a per-bridge typed sender. Used to type the values of
 * the tag→sender map built by {@link senderByTag} — the precise sender
 * signatures lose their per-bridge narrowing at the routing site, and
 * runtime dispatch happens by `_tag`.
 */
type AnyTaggedMessageSender = (message: {
  readonly _tag: string
}) => Effect.Effect<void, never, TransportAdapter>

/**
 * Build a `{[tag]: bridgeSenderForTag}` map across a list of bridges for one
 * side. Throws on outbound-tag collisions — same wiring-error policy the
 * transport's inbound dup check enforces.
 */
const senderByTag = (
  bridges: ReadonlyArray<Bridge.AnyBridge>,
  side: 'Host' | 'Web'
): Map<string, AnyTaggedMessageSender> => {
  const map = new Map<string, AnyTaggedMessageSender>()
  for (const bridge of bridges) {
    const half = bridge[side]
    for (const tag of Object.keys(half.OutboundSchemas)) {
      if (map.has(tag)) {
        throw new Error(`[effect-messaging] duplicate outbound tag "${tag}" across bridges`)
      }
      // `half.send` is typed `(m: never) => …`; runtime dispatch by `_tag` lands every message correctly.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      map.set(tag, half.send as AnyTaggedMessageSender)
    }
  }
  return map
}

/**
 * Look up the URL-param schema for a tag across a list of bridges.
 * Throws on duplicate-tag conflicts so wiring drift fails synchronously.
 */
const findUrlParamSchema = (
  bridges: ReadonlyArray<Bridge.AnyBridge>,
  tag: string
): Message.AnyStringEncodedSchema | undefined => {
  const matchingUrlParamSchemas = Array.filterMap(bridges, (bridge) =>
    Option.fromNullable(bridge.UrlParamSchemas[tag])
  )
  if (matchingUrlParamSchemas.length > 1) {
    throw new Error(`[effect-messaging] duplicate urlParams tag "${tag}" across bridges`)
  } else if (matchingUrlParamSchemas.length === 1) {
    return matchingUrlParamSchemas[0]
  } else {
    return undefined
  }
}

/**
 * Look up the wire (host→web) schema for a tag across the bridges.
 * Used by the URL decoder to re-encode the decoded message as the
 * canonical wire JSON the dispatch fiber consumes.
 */
const findWireSchema = (
  bridges: ReadonlyArray<Bridge.AnyBridge>,
  tag: string
): Message.AnyStringEncodedSchema | undefined => {
  for (const bridge of bridges) {
    const schema = bridge.Web.InboundSchemas[tag]
    if (schema !== undefined) return schema
  }
  return undefined
}

export { findUrlParamSchema, findWireSchema, senderByTag }
