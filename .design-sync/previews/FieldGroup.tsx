import { useState } from 'react'
import { Checkbox, FieldDescription, FieldGroup } from 'react-tundraish'

/**
 * `FieldGroup` labels a *set* of controls rather than a single input — a
 * `<label>` can only bind to one control, so the group is exposed as
 * `role="group"` named by the group label. The canonical use: a label over
 * several checkboxes.
 */
export const CheckboxSet = () => {
  const [state, setState] = useState({ email: true, sms: false, push: true })
  return (
    <div style={{ maxWidth: 400 }}>
      <FieldGroup label="Notification channels">
        <FieldDescription>Choose where we send alerts about your account.</FieldDescription>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <Checkbox checked={state.email} label="Email" onChange={(v) => setState((s) => ({ ...s, email: v }))} />
          <Checkbox checked={state.sms} label="SMS" onChange={(v) => setState((s) => ({ ...s, sms: v }))} />
          <Checkbox checked={state.push} label="Push notification" onChange={(v) => setState((s) => ({ ...s, push: v }))} />
        </div>
      </FieldGroup>
    </div>
  )
}

/** Without a description — just the group label over the controls. */
export const Bare = () => {
  const [state, setState] = useState({ analytics: false, crash: true })
  return (
    <div style={{ maxWidth: 400 }}>
      <FieldGroup label="Diagnostics">
        <div style={{ display: 'grid', gap: 8 }}>
          <Checkbox checked={state.analytics} label="Share usage analytics" onChange={(v) => setState((s) => ({ ...s, analytics: v }))} />
          <Checkbox checked={state.crash} label="Send crash reports" onChange={(v) => setState((s) => ({ ...s, crash: v }))} />
        </div>
      </FieldGroup>
    </div>
  )
}
