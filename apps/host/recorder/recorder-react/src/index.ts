/**
 * The Recorder's browser surface: {@link RecorderPage}, the page an app
 * mounts, the `useRecorder` state machine behind it, and the two pieces of
 * bridge wiring the app provides around it: `RecorderSenderProvider` and the
 * `HandlerCoordinatorContext` the page registers through.
 *
 * @packageDocumentation
 */
export { RecorderPage, type RecorderPageProps } from './recorder-page.tsx'
export {
  RecorderSenderProvider,
  type RecorderSenderProviderProps,
} from './recorder-sender-provider.tsx'
export type { RecorderOutboundMessage, RecorderSender } from './recorder-sender-context.ts'
export { useRecorderRegister } from './use-recorder-register.ts'
export { useRecorderSender } from './use-recorder-sender.ts'
export { useRecorder, type Recorder, type RecorderState } from './use-recorder.ts'
export { useSaveFolder, type SaveFolderState } from './use-save-folder.ts'
