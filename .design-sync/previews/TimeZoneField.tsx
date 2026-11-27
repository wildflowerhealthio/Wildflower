import { useState } from 'react'
import { TimeZoneField } from '@wildflowerhealthio/react-tundraish'

/** The canonical use — a report's zone, with the likely ones suggested. */
export const WithSuggestions = () => {
  const [timeZone, setTimeZone] = useState('America/Toronto')
  return (
    <div style={{ maxWidth: 360 }}>
      <TimeZoneField
        label="Report time zone"
        value={timeZone}
        onChange={setTimeZone}
        suggestions={['America/Toronto', 'America/Vancouver']}
        description="The zone the report's printed times are in."
      />
    </div>
  )
}

/** A name the runtime does not recognize — flagged, and never reported. */
export const Unrecognized = () => (
  <div style={{ maxWidth: 360 }}>
    <TimeZoneField
      label="Equipment time zone"
      value="America/Tor"
      onChange={() => {}}
      suggestions={['America/Toronto', 'America/Halifax', 'UTC']}
    />
  </div>
)
