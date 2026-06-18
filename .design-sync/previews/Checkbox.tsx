import { useState } from 'react'
import { Checkbox } from 'react-tundraish'

/** Single checkbox, checked, with a typeset label — the canonical use. */
export const Checked = () => {
  const [on, setOn] = useState(true)
  return <Checkbox checked={on} label="Email me about account activity" onChange={setOn} />
}

/** Unchecked default state. */
export const Unchecked = () => {
  const [on, setOn] = useState(false)
  return <Checkbox checked={on} label="Subscribe to the monthly newsletter" onChange={setOn} />
}

/** Disabled — interaction suppressed; `onChange` is optional when `disabled`. */
export const Disabled = () => (
  <div style={{ display: 'grid', gap: 8 }}>
    <Checkbox checked disabled label="Two-factor authentication (enforced by your org)" />
    <Checkbox checked={false} disabled label="Beta features (not available on your plan)" />
  </div>
)

/** A real settings cluster — several rows stacked the way forms use them. */
export const SettingsList = () => {
  const [state, setState] = useState({ activity: true, marketing: false, security: true })
  return (
    <div style={{ display: 'grid', gap: 10, maxWidth: 360 }}>
      <Checkbox
        checked={state.activity}
        label="Account activity"
        onChange={(v) => setState((s) => ({ ...s, activity: v }))}
      />
      <Checkbox
        checked={state.marketing}
        label="Product news & offers"
        onChange={(v) => setState((s) => ({ ...s, marketing: v }))}
      />
      <Checkbox
        checked={state.security}
        label="Security alerts"
        onChange={(v) => setState((s) => ({ ...s, security: v }))}
      />
    </div>
  )
}
