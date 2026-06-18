import { useState } from 'react'
import { Checkbox, Field, FieldDescription, FieldGroup } from 'react-tundraish'

/** A field labelling a single input — `htmlFor` ties the label to the control. */
export const LabelledInput = () => (
  <div style={{ maxWidth: 360 }}>
    <Field label="Display name" htmlFor="display-name">
      <input
        id="display-name"
        className="input-2"
        defaultValue="Ruth Marks"
        style={{ width: '100%' }}
      />
    </Field>
  </div>
)

/** Read-only label/value stack — omit `htmlFor`; the label renders as a span. */
export const ReadOnlyValue = () => (
  <div style={{ maxWidth: 360 }}>
    <Field label="Workspace ID">
      <span className="text-body-2">ws_8f21c0a4e7</span>
    </Field>
  </div>
)

/** Field paired with a `FieldDescription` for secondary explanatory text. */
export const WithDescription = () => (
  <div style={{ maxWidth: 400 }}>
    <Field label="API token" htmlFor="api-token">
      <input id="api-token" className="input-2" defaultValue="sk-live-…" style={{ width: '100%' }} />
      <FieldDescription>
        Treat this like a password. Tokens grant full access to your account and can be revoked at
        any time from the security settings.
      </FieldDescription>
    </Field>
  </div>
)

/** `FieldGroup` labels a *set* of controls — a group label over several checkboxes. */
export const GroupOfControls = () => {
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

/** A realistic settings form — several fields stacked the way a page uses them. */
export const SettingsForm = () => (
  <div style={{ display: 'grid', gap: 20, maxWidth: 400 }}>
    <Field label="Full name" htmlFor="sf-name">
      <input id="sf-name" className="input-2" defaultValue="Ruth Marks" style={{ width: '100%' }} />
    </Field>
    <Field label="Email" htmlFor="sf-email">
      <input id="sf-email" className="input-2" type="email" defaultValue="ruth@example.com" style={{ width: '100%' }} />
      <FieldDescription>Used for sign-in and account recovery.</FieldDescription>
    </Field>
    <Field label="Plan">
      <span className="text-body-2">Team — renews 1 Jul 2026</span>
    </Field>
  </div>
)
