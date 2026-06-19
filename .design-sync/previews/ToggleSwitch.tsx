import { useState } from 'react'
import { ToggleSwitch } from 'react-tundraish'

/** On — the live state, knob slid to the colored end of the track. */
export const On = () => {
  const [on, setOn] = useState(true)
  return <ToggleSwitch checked={on} label="Run tunnel" onChange={setOn} />
}

/** Off — the resting state. */
export const Off = () => {
  const [on, setOn] = useState(false)
  return <ToggleSwitch checked={on} label="Pause syncing" onChange={setOn} />
}

/** Disabled — interaction suppressed; `onChange` may be omitted when disabled. */
export const Disabled = () => (
  <div style={{ display: 'grid', gap: 10 }}>
    <ToggleSwitch checked disabled label="Maintenance mode (set by your admin)" />
    <ToggleSwitch checked={false} disabled label="Beta channel (not on your plan)" />
  </div>
)

/** A real settings cluster — several instantly-applied toggles stacked. */
export const SettingsList = () => {
  const [state, setState] = useState({ tunnel: true, telemetry: false, autostart: true })
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
      <ToggleSwitch
        checked={state.tunnel}
        label="Run tunnel"
        onChange={(v) => setState((s) => ({ ...s, tunnel: v }))}
      />
      <ToggleSwitch
        checked={state.telemetry}
        label="Share usage telemetry"
        onChange={(v) => setState((s) => ({ ...s, telemetry: v }))}
      />
      <ToggleSwitch
        checked={state.autostart}
        label="Start on launch"
        onChange={(v) => setState((s) => ({ ...s, autostart: v }))}
      />
    </div>
  )
}
