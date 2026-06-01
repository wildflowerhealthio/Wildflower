import { Array, Option } from 'effect'
import type * as Bridge from '../bridge.ts'
import type * as Message from '../message.ts'
import { assertNoDuplicateTags } from './assert-no-duplicate-tags.ts'

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
  assertNoDuplicateTags(
    Array.map(matchingUrlParamSchemas, () => tag),
    'urlParams'
  )
  return matchingUrlParamSchemas[0]
}

/**
 * Look up the wire (host→web) schema for a tag across the bridges.
 * Used by the URL decoder to re-encode the decoded message as the
 * canonical wire JSON the dispatch fiber consumes. Throws on
 * duplicate-tag conflicts, mirroring {@link findUrlParamSchema}.
 */
const findWireSchema = (
  bridges: ReadonlyArray<Bridge.AnyBridge>,
  tag: string
): Message.AnyStringEncodedSchema | undefined => {
  const matchingWireSchemas = Array.filterMap(bridges, (bridge) =>
    Option.fromNullable(bridge.HostToWeb[tag])
  )
  assertNoDuplicateTags(
    Array.map(matchingWireSchemas, () => tag),
    'wire'
  )
  return matchingWireSchemas[0]
}

export { findUrlParamSchema, findWireSchema }
