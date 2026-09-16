/**
 * The HAR Recorder's browser surface: the `useHarRecorder` state machine, the
 * two hooks the app's bridge wiring needs (`HarRecorderSenderProvider` and the
 * coordinator accessor), and — mounted through the app's `routes.config.ts`,
 * not through this entry — the `/har-recorder` page under `src/routes`.
 *
 * @packageDocumentation
 */
export {
  HarRecorderSenderProvider,
  type HarRecorderSenderProviderProps,
} from './har-recorder-sender-provider.tsx'
export type {
  HarRecorderOutboundMessage,
  HarRecorderSender,
} from './har-recorder-sender-context.ts'
export { useHarRecorderRegister } from './use-har-recorder-register.ts'
export { useHarRecorderSender } from './use-har-recorder-sender.ts'
export { useHarRecorder, type HarRecorder, type HarRecorderState } from './use-har-recorder.ts'
