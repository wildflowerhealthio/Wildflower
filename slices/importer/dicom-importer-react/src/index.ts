/**
 * The DICOM format's UI for the importer slice: the
 * {@link DicomSettingsPicker} (renders nothing — no user-facing knobs yet).
 * The DICOM format needs no interactive review body — the decode yields zero
 * sections and one note, so the shell renders only the source-file archive.
 *
 * @packageDocumentation
 */
export { type SettingsPickerProps } from 'importer-fundamentals'
export { DicomSettingsPicker } from './settings-picker.tsx'
