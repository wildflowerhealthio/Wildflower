/**
 * The DICOM format's UI for the importer slice: the
 * {@link DicomSettingsPicker} (the equipment time zone — the one knob the
 * format has): the IANA zone the acquiring equipment's clock was set to.
 *
 * The DICOM format needs no interactive review body — the shell's generalized
 * per-resource review covers everything the decode yields.
 *
 * @packageDocumentation
 */
export { type SettingsPickerProps } from 'importer-fundamentals'
export { COMMIT_DELAY_MS, DicomSettingsPicker, UNKNOWN_ZONE_MESSAGE } from './settings-picker.tsx'
export { NORTH_AMERICAN_TIME_ZONES, suggestedTimeZones } from './time-zones.ts'
