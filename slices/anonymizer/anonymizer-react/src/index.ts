/**
 * The anonymizer shell: the screen a host app mounts — one local picker,
 * best-effort identification against the closed format registry, and the
 * routed format panel. Client-side end to end; issues no writes.
 *
 * @packageDocumentation
 */
export {
  AnonymizerScreen,
  type AnonymizerScreenProps,
  UNIDENTIFIED_ERROR,
} from './anonymizer-screen.tsx'
export { LocalFilePicker, type LocalFilePickerProps } from './local-file-picker.tsx'
export { type BoundFormat, formatRegistry } from './registry.tsx'
