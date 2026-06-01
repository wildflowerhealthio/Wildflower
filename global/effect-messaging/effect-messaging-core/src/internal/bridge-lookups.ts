import { Array, Option } from 'effect'
import type * as Bridge from '../bridge.ts'
import type * as Message from '../message.ts'

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
    const schema = bridge.HostToWeb[tag]
    if (schema !== undefined) return schema
  }
  return undefined
}

export { findUrlParamSchema, findWireSchema }
