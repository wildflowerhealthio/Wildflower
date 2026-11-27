import { HealthCardProvince } from '@wildflowerhealthio/fhir-ca-infoway'
import type { SettingsPickerProps } from '@wildflowerhealthio/importer-fundamentals'
import type { LifeLabsPdfSettings } from '@wildflowerhealthio/lifelabs-pdf-importer-core'
import { Field, TimeZoneField } from '@wildflowerhealthio/react-tundraish'
import { type JSX, useId } from 'react'

import { SUGGESTED_TIME_ZONES } from './time-zones.ts'

/**
 * The LifeLabs PDF format's settings picker: the IANA time zone the report's
 * printed clock is in, and the province that issued the health card it prints.
 *
 * @remarks
 * The zone is a `react-tundraish` `TimeZoneField` over the two LifeLabs
 * provinces' zones. It reports only a zone the runtime recognizes, after a
 * short wait (flushed on blur or Enter): each report re-reads every LifeLabs
 * file under the new settings, and a half-typed name would make each report
 * unreadable, dropping its records from the import plan and the reviewer's
 * choices on them. A zone set from outside while it is mounted replaces
 * what it shows.
 *
 * The province is a `<select>` of `fhir-ca-infoway`'s `HealthCardProvince`s:
 * Ontario, British Columbia, and "Other province" for a card from anywhere
 * else, reported up as soon as it is picked. The picker is a fragment of the
 * two fields, so the container it is placed in lays them out.
 */
const LifeLabsPdfSettingsPicker = ({
  settings,
  onChange,
}: SettingsPickerProps<LifeLabsPdfSettings>): JSX.Element => {
  const provinceId = useId()
  return (
    <>
      <TimeZoneField
        label="Report time zone"
        value={settings.timeZone}
        suggestions={SUGGESTED_TIME_ZONES}
        onChange={(timeZone) => onChange({ ...settings, timeZone })}
      />
      <Field label="Health card province" htmlFor={provinceId}>
        <select
          id={provinceId}
          className="input-3"
          value={settings.healthCardProvince}
          onChange={(event) => {
            const healthCardProvince = event.currentTarget.value
            if (HealthCardProvince.is(healthCardProvince))
              onChange({ ...settings, healthCardProvince })
          }}
        >
          {HealthCardProvince.all.map((province) => (
            <option key={province} value={province}>
              {HealthCardProvince.names[province]}
            </option>
          ))}
        </select>
      </Field>
    </>
  )
}

export { LifeLabsPdfSettingsPicker }
