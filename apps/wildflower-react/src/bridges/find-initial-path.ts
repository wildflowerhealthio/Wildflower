import { NavigationBridge } from 'contracts-core'
import { Either, Schema } from 'effect'
import { Message } from 'effect-messaging-core'

const decodeEnvelope = Schema.decodeUnknownEither(Message.wireRoutingEnvelope)
const decodeNavigation = Schema.decodeEither(
  NavigationBridge.MessageSchemas.HostRequestedWebNavigation
)

/**
 * Find the path the host requested in the pre-injected initial messages.
 * Returns `'/'` when no `HostRequestedWebNavigation` entry is present
 * (e.g. the bundle is running standalone-web). Malformed entries — JSON
 * that doesn't match the envelope — are surfaced via `console.warn` so a
 * malformed first entry isn't indistinguishable from "no host route".
 * Entries with the wrong tag are skipped silently (the bridge replay
 * fiber is the canonical decoder; we only peek for the route).
 */
const findInitialPath = (messages: ReadonlyArray<string>): string => {
  for (const entry of messages) {
    const envelopeResult = decodeEnvelope(entry)
    if (Either.isLeft(envelopeResult)) {
      console.warn(
        '[wildflower-react] dropping malformed initial message while seeking initial route',
        envelopeResult.left
      )
      continue
    }
    if (envelopeResult.right._tag !== 'HostRequestedWebNavigation') continue
    const navResult = decodeNavigation(entry)
    if (Either.isLeft(navResult)) {
      console.warn(
        '[wildflower-react] HostRequestedWebNavigation envelope failed payload decode',
        navResult.left
      )
      continue
    }
    return navResult.right.path
  }
  return '/'
}

export { findInitialPath }
