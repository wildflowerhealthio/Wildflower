import { NavigationBridge } from 'contracts-core'
import { Schema } from 'effect'
import { Message } from 'effect-messaging-core'
import * as Transport from './transport.ts'
/**
 * Find the path the host requested in the pre-injected initial
 * messages. Returns `'/'` when no `HostRequestedWebNavigation` entry
 * is present (e.g. the bundle is running standalone-web).
 */
const findInitialPath = (messages: ReadonlyArray<string>): string => {
  for (const entry of messages) {
    try {
      const envelope = Schema.decodeUnknownSync(Message.wireRoutingEnvelope)(entry)
      if (envelope._tag === 'HostRequestedWebNavigation') {
        return Schema.decodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)(entry)
          .path
      }
    } catch {
      continue
    }
  }
  return '/'
}

/**
 * Initial path extracted from the drained initial messages. Used by
 * `<MemoryRouter initialEntries={[initialEntry]}>` so the router
 * mounts at the right path on first paint, before the dispatch
 * fiber's replay arrives.
 */
export const initialPath = findInitialPath(Transport.initialMessages)
