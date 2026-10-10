/**
 * The HAR anonymizer's UI: the {@link AnonymizePanel} a host mounts over a
 * parsed HTTP Archive to review the pseudonymizer's decisions and download an
 * anonymized `.har`.
 *
 * @remarks
 * Presentation and interaction only. The redactor and the HAR emitter live in
 * `har-importer-core`; nothing here reimplements either. The panel takes a
 * decoded `HttpArchive.Log`, drives `har-anonymizer-core`'s
 * `buildPolicyForLog` + `redactLog`, and hands the result to
 * `emitHarFromLog`. The `<original-stem>.anonymized.har` file it saves is a
 * same-origin blob — no network egress at any point.
 *
 * @packageDocumentation
 */
export { AnonymizePanel, type AnonymizePanelProps } from './anonymize-panel.tsx'
export { anonymizedFileName, downloadBlob, HAR_MEDIA_TYPE, harBlob } from './download-har.ts'
export {
  type AnonymizePreview,
  buildAnonymizePreview,
  droppedBodyCount,
  jsonBodyCount,
  type PreviewRow,
  sampleLeaves,
} from './redaction-preview.ts'
export {
  type AnonymizeSettings,
  type AnonymizeState,
  DEFAULT_ANONYMIZE_SETTINGS,
  describeSettings,
  useAnonymize,
} from './use-anonymize.ts'
