/**
 * The HAR format's UI for the importer slice: the (no-op) HAR
 * {@link HarSettingsPicker} and the interactive per-URL {@link ReviewBody} the
 * shell mounts inside its preview.
 *
 * @remarks
 * Presentation and interaction only — a view over `importer-fundamentals`' pure
 * `Review` model and `har-importer-core`'s descriptor. Nothing here decodes a
 * HAR, recognizes traffic, or writes resources; it drives the selection state
 * the shell decodes on confirm.
 *
 * @packageDocumentation
 */
export { ReviewBody, type ReviewBodyProps } from './review-body.tsx'
export { HarSettingsPicker, type SettingsPickerProps } from './settings-picker.tsx'
