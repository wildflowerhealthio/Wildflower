import { Effect } from 'effect'
import type { ServerServiceStatus } from 'wildflower-server-core-js'

import type {
  BackgroundServerServiceOutboundMessage,
  BackgroundServerServiceSender,
} from './background-server-service-sender-context.ts'
import {
  makeServerServiceStatusStore,
  type ServerServiceStatusStore,
} from './server-service-status-store.ts'

/** A sender that records every message instead of reaching a host. */
const makeRecordingSender = (): {
  readonly sent: BackgroundServerServiceOutboundMessage[]
  readonly send: BackgroundServerServiceSender
} => {
  const sent: BackgroundServerServiceOutboundMessage[] = []
  return {
    sent,
    send: (message) =>
      Effect.sync(() => {
        sent.push(message)
      }),
  }
}

/** A store already holding `status`, as after the host's first snapshot. */
const storeHolding = (status: ServerServiceStatus | null): ServerServiceStatusStore => {
  const store = makeServerServiceStatusStore()
  if (status !== null) store.setStatus(status)
  return store
}

export { makeRecordingSender, storeHolding }
