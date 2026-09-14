import type { DicomSettings } from 'dicom-importer-core'
import type { SettingsPickerProps } from 'importer-fundamentals'
import type { JSX } from 'react'

/**
 * The DICOM format's settings picker: renders nothing — there are no
 * user-facing knobs yet. The format stores the file as an archive with no
 * tag parsing (D3 fills that in), so there is nothing for the user to
 * configure at import time.
 */
const DicomSettingsPicker = (_props: SettingsPickerProps<DicomSettings>): JSX.Element => <></>

export { DicomSettingsPicker }
