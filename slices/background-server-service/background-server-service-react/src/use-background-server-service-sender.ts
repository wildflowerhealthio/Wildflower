import { useContextOrThrow } from 'react-kitchen-sink'

import {
  BackgroundServerServiceSenderContext,
  type BackgroundServerServiceSender,
} from './background-server-service-sender-context.ts'

/**
 * Returns the `BackgroundServerServiceBridge` Web→Host sender.
 *
 * @throws `NoContextException` when no `<BackgroundServerServiceSenderProvider>`
 *   is in the tree — the app's `BackgroundServerServiceSenderForwarder` always
 *   provides one.
 */
const useBackgroundServerServiceSender = (): BackgroundServerServiceSender =>
  useContextOrThrow(BackgroundServerServiceSenderContext)

export { useBackgroundServerServiceSender }
