/**
 * The HAR Recorder's pure core: accumulate the browser-sniffer's response
 * events into an `HttpArchive.Log`, emit it as a HAR 1.2 archive, name the file
 * it is saved as, and carry that file to the host over `HarRecorderBridge`.
 *
 * @packageDocumentation
 */
export { HarRecorderBridge, HarSaveFailed, HarSaved, SaveHar } from './bridge.ts'
export { MAX_FILE_NAME_LENGTH, recordingFileName } from './file-name.ts'
export { isOmittedFromRecording } from './omitted.ts'
export { MAX_BODY_BYTES, Recording } from './recording.ts'
export { CREATOR_NAME, REQUEST_COMMENT, type ToHarOptions, toHar } from './to-har.ts'
