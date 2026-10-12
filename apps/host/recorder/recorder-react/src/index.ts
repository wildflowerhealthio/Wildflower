/**
 * The Recorder's browser surface: {@link RecorderPage}, the page an app
 * mounts; `RecorderProvider`, which runs the `useRecorder` state machine behind
 * it for as long as the app keeps it mounted; and the two pieces of bridge
 * wiring the app provides around that: `RecorderSenderProvider` and the
 * `HandlerCoordinatorContext` the recorder registers through.
 *
 * @packageDocumentation
 */
export { RecorderPage, type RecorderPageProps } from './recorder-page.tsx'
export { useProvidedRecorder } from './recorder-context.ts'
export { RecorderProvider, type RecorderProviderProps } from './recorder-provider.tsx'
export {
  RecorderSenderProvider,
  type RecorderSenderProviderProps,
} from './recorder-sender-provider.tsx'
export type { RecorderOutboundMessage, RecorderSender } from './recorder-sender-context.ts'
export { useRecorderRegister } from './use-recorder-register.ts'
export { useRecorderSender } from './use-recorder-sender.ts'
export { useRecorder, type Recorder, type RecorderState } from './use-recorder.ts'
export { useSaveFolder, type SaveFolderState } from './use-save-folder.ts'
