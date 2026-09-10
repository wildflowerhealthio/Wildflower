/**
 * The LifeLabs PDF format's UI for the importer slice: the
 * {@link LifeLabsPdfSettingsPicker} (the report's time zone). The LifeLabs PDF
 * format needs no interactive review body — every resource the decode pipeline
 * yields is a candidate, and the general per-resource selection (exclude/edit)
 * is rendered by the shell.
 *
 * @packageDocumentation
 */
export { type SettingsPickerProps } from 'har-importer-react'
export {
  LifeLabsPdfSettingsPicker,
  SUGGESTED_TIME_ZONES,
  UNKNOWN_ZONE_MESSAGE,
} from './settings-picker.tsx'
