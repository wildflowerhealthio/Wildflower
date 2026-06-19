import { useState } from 'react'
import { TextField } from 'react-tundraish'

/** The canonical use — a labeled input with a helper line beneath it. */
export const WithDescription = () => {
  const [host, setHost] = useState('my-clinic.example.com')
  return (
    <div style={{ maxWidth: 360 }}>
      <TextField
        label="Public host"
        value={host}
        onChange={setHost}
        inputMode="url"
        placeholder="my-clinic.example.com"
        description="The public domain the relay routes to this device."
      />
    </div>
  )
}

/** `callout` accents the border — the one field the user is here to change. */
export const Callout = () => {
  const [name, setName] = useState('')
  return (
    <div style={{ maxWidth: 360 }}>
      <TextField
        label="Service name"
        value={name}
        onChange={setName}
        callout
        placeholder="wildflower-device-1"
        description="Never shown — enter a new token to change the connection."
      />
    </div>
  )
}

/** A short form cluster — the way several text fields stack on a settings page. */
export const FormCluster = () => {
  const [form, setForm] = useState({ name: 'Demo FHIR Server', url: 'https://fhir.example.org/r4' })
  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 360 }}>
      <TextField
        label="Display name"
        value={form.name}
        onChange={(v) => setForm((s) => ({ ...s, name: v }))}
      />
      <TextField
        label="Base URL"
        value={form.url}
        onChange={(v) => setForm((s) => ({ ...s, url: v }))}
        inputMode="url"
        description="The FHIR R4 base endpoint."
      />
    </div>
  )
}

/** Disabled — the input is locked while a mutation is in flight. */
export const Disabled = () => (
  <div style={{ maxWidth: 360 }}>
    <TextField
      label="API token"
      type="password"
      value="sk-live-redacted"
      onChange={() => {}}
      disabled
      description="Locked while the connection is saving."
    />
  </div>
)
