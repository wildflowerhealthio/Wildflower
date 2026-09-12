/**
 * The HAR format's UI for the importer slice: the {@link HarSettingsPicker},
 * the whole-import response-kind toggles the shell mounts with its settings
 * form.
 *
 * @remarks
 * Presentation and interaction only — a view over `har-importer-core`'s
 * sources and settings. Nothing here decodes a HAR, recognizes traffic, or
 * writes resources; the shell re-decodes through the descriptor when the
 * settings change. The format needs no review UI of its own — the shell's
 * generalized sectioned review (per-resource include/edit) covers it.
 *
 * @packageDocumentation
 */
export { HarSettingsPicker } from './settings-picker.tsx'
export type { SettingsPickerProps } from 'importer-fundamentals'
