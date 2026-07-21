import type { ConfigFormProps } from 'collector-fundamentals/config-form'
import { Either, ParseResult, Schema } from 'effect'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { pageLayoutStyles } from 'react-tundraish'

import { defaultConfig, InstanceConfig } from './config.ts'
import fields from './lifelabs-config-form.module.css'

/** The decoded LifeLabs per-instance config (`{ _tag, username, password }`). */
type LifeLabsConfig = typeof InstanceConfig.Type

/**
 * The LifeLabs config fields (username / password) as a {@link ConfigFormProps}
 * form. `collector-react` registers it against the `lifelabs` tag in its
 * `tag → form` registry. Fields seed `initial` → `prefill` → {@link defaultConfig},
 * and Save decodes them through {@link InstanceConfig}, rendering any `ParseError`
 * inline instead of round-tripping bad input to the server. The password field
 * is `type="password"` so it renders masked. Mirrors `RexallConfigForm`.
 */
function LifeLabsConfigForm({
  initial,
  prefill,
  disabled,
  onSubmit,
  header,
  footer,
}: ConfigFormProps<LifeLabsConfig>): JSX.Element {
  const [username, setUsername] = useState(
    initial?.username ?? prefill?.['username'] ?? defaultConfig.username
  )
  const [password, setPassword] = useState(
    initial?.password ?? prefill?.['password'] ?? defaultConfig.password
  )
  const [fieldError, setFieldError] = useState<string | null>(null)

  const submit = (): void => {
    const decoded = Schema.decodeUnknownEither(InstanceConfig)({
      _tag: 'lifelabs',
      username,
      password,
    })
    if (Either.isLeft(decoded)) {
      setFieldError(ParseResult.TreeFormatter.formatErrorSync(decoded.left))
      return
    }
    setFieldError(null)
    onSubmit(decoded.right)
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {header}

      {fieldError !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{fieldError}</p>
      ) : null}

      <div className={fields['field']}>
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-username">
          Username
        </label>
        <input
          id="cl-username"
          className="input-2"
          type="email"
          value={username}
          disabled={disabled}
          onChange={(e) => {
            setUsername(e.target.value)
          }}
          placeholder="you@example.com"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className={fields['field']}>
        <label className={cn(fields['field__label'], 'text-label-3')} htmlFor="cl-password">
          Password
        </label>
        <input
          id="cl-password"
          className="input-2"
          type="password"
          value={password}
          disabled={disabled}
          onChange={(e) => {
            setPassword(e.target.value)
          }}
          placeholder="Password"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      {footer}
    </form>
  )
}

export { LifeLabsConfigForm }
export type { LifeLabsConfig }
