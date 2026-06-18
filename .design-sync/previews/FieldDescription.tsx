import { Field, FieldDescription } from 'react-tundraish'

/**
 * Secondary explanatory text inside a `<Field>` — typeset as `text-body-3` and
 * tinted with the field's muted color. This is its real home: a description
 * under the labelled control.
 */
export const UnderInput = () => (
  <div style={{ maxWidth: 400 }}>
    <Field label="API token" htmlFor="fd-token">
      <input id="fd-token" className="input-2" defaultValue="sk-live-…" style={{ width: '100%' }} />
      <FieldDescription>
        Treat this like a password. Tokens grant full access to your account and can be revoked at
        any time from the security settings.
      </FieldDescription>
    </Field>
  </div>
)

/** A short one-line description — the common case. */
export const Terse = () => (
  <div style={{ maxWidth: 400 }}>
    <Field label="Email" htmlFor="fd-email">
      <input id="fd-email" className="input-2" type="email" defaultValue="ruth@example.com" style={{ width: '100%' }} />
      <FieldDescription>Used for sign-in and account recovery.</FieldDescription>
    </Field>
  </div>
)
