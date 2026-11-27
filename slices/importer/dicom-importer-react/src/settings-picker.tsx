import type { DicomSettings } from '@wildflowerhealthio/dicom-importer-core'
import type { SettingsPickerProps } from '@wildflowerhealthio/importer-fundamentals'
import { TimeZoneField } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { suggestedTimeZones } from './time-zones.ts'

const ZONE_OPTIONS = suggestedTimeZones()

/**
 * The DICOM format's settings picker: the one knob the format has, the IANA
 * time zone the acquiring equipment's clock was set to.
 *
 * @remarks
 * A `react-tundraish` `TimeZoneField` over the likely zones. It reports only
 * a zone the runtime recognizes, after a short wait (flushed on blur or
 * Enter), because each report re-decodes every DICOM file in the batch and
 * re-runs the server comparison, and a half-typed name would flip each file to
 * "could not be read" and back on the way through. A zone set from outside
 * while it is mounted replaces what it shows.
 */
const DicomSettingsPicker = ({
  settings,
  onChange,
}: SettingsPickerProps<DicomSettings>): JSX.Element => (
  <TimeZoneField
    label="Equipment time zone"
    value={settings.timeZone}
    suggestions={ZONE_OPTIONS}
    onChange={(timeZone) => onChange({ ...settings, timeZone })}
  />
)

export { DicomSettingsPicker }
