import { descriptorForTag, type CollectorTag, type ConfigForTag } from 'collector-registry/registry'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, PageHeader } from 'react-tundraish'

import { configFormForTag } from './config-form.tsx'
import styles from './account-form.module.css'

interface AccountFormScreenProps<T extends CollectorTag> {
  /** Header title — "Add Account" / "Edit Account". */
  readonly title: string
  /** The collector being configured; selects the config form + display strings. */
  readonly tag: T
  /** Existing stored config to seed from (edit), or `undefined` (create). */
  readonly initial: ConfigForTag<T> | undefined
  /** Loose seed bag from the create-screen search; `undefined` on edit. */
  readonly prefill: Record<string, string> | undefined
  /** Initial account-name value (a stored name, or a `prefill['name']`). */
  readonly initialName: string
  /** Mirrors the owning mutation's pending state. */
  readonly disabled: boolean
  /**
   * The owning mutation's error, surfaced in the banner — a `403
   * InsufficientScope` renders the permission surface (naming the missing
   * scopes), anything else a plain message; `null`/absent when idle.
   */
  readonly error: unknown
  /** Called with the resolved name + decoded config once the fields validate. */
  readonly onSubmit: (name: string, config: ConfigForTag<T>) => void
  readonly onCancel: () => void
}

/**
 * The generic account create/edit screen. It owns the chrome shared across
 * every collector — the page header, the type badge, the account-name field,
 * the mutation-error banner, and the Save/Cancel row — and hosts the
 * per-collector {@link configFormForTag config form} for `tag`, handing it the
 * name field + type badge as its `header` and the Save/Cancel row as its
 * `footer`. The config form owns its fields and decodes on submit; this screen
 * only fills in the account name (defaulting an empty name to
 * `"<collector title> <date>"`) before forwarding to {@link onSubmit}.
 *
 * Both `account.new` and `account.$id` render this; the create/update wiring
 * (which mutation, `initial`, `prefill`) is the only difference and lives in
 * those thin route components.
 */
function AccountFormScreen<T extends CollectorTag>({
  title,
  tag,
  initial,
  prefill,
  initialName,
  disabled,
  error,
  onSubmit,
  onCancel,
}: AccountFormScreenProps<T>): JSX.Element {
  const descriptor = descriptorForTag(tag)
  const ConfigForm = configFormForTag(tag)
  const [name, setName] = useState(initialName)

  const handleSubmit = (config: ConfigForTag<T>): void => {
    const remoteName =
      name === ''
        ? `${descriptor?.display.title ?? ''} ${new Date().toLocaleDateString()}`.trim()
        : name
    onSubmit(remoteName, config)
  }

  return (
    <>
      <PageHeader title={title} backHref="/collector" backLabel="Collector" />

      <ErrorBanner error={error} />

      <ConfigForm
        initial={initial}
        prefill={prefill}
        disabled={disabled}
        onSubmit={handleSubmit}
        header={
          <>
            <div className={styles['field']}>
              <label className={cn(styles['field__label'], 'text-label-3')}>Type</label>
              <span className={cn(styles['type-badge'], 'text-body-3')}>
                {descriptor?.display.title ?? tag}
              </span>
            </div>

            <div className={styles['field']}>
              <label className={cn(styles['field__label'], 'text-label-3')} htmlFor="cl-name">
                Name
              </label>
              <input
                id="cl-name"
                className="input-2"
                value={name}
                disabled={disabled}
                onChange={(e) => {
                  setName(e.target.value)
                }}
                placeholder="Account name"
              />
            </div>
          </>
        }
        footer={
          <div className={styles['button-row']}>
            <button type="submit" className="button-2 filled" disabled={disabled}>
              Save
            </button>
            <button type="button" className="button-2 outline" onClick={onCancel}>
              Cancel
            </button>
          </div>
        }
      />
    </>
  )
}

export { AccountFormScreen }
export type { AccountFormScreenProps }
