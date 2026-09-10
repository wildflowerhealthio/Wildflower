/**
 * The LifeLabs PDF format's UI for the importer slice: the
 * {@link LifeLabsPdfSettingsPicker} (the report's time zone) and the
 * per-report {@link ReviewBody} the shell mounts inside its preview.
 *
 * @remarks
 * The review is `har-importer-react`'s, re-exported: it is a view over
 * `importer-fundamentals`' format-agnostic `Review` model, grouping a file's
 * responses by URL — for this format, the one URL the decode mints per file —
 * with the same per-resource include toggles and inline editor. Nothing here
 * decodes a report, recognizes it, or writes resources.
 *
 * @packageDocumentation
 */
export { ReviewBody, type ReviewBodyProps, type SettingsPickerProps } from 'har-importer-react'
export {
  LifeLabsPdfSettingsPicker,
  SUGGESTED_TIME_ZONES,
  UNKNOWN_ZONE_MESSAGE,
} from './settings-picker.tsx'
