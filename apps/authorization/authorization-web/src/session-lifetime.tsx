import type { Client, RefreshPolicy } from '@wildflowerhealthio/authorization-core/domain'
import { useUpdateRefreshPolicyMutation } from '@wildflowerhealthio/authorization-react'
import { Checkbox, ErrorBanner, Field } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import { useId, useState, type ChangeEvent, type JSX } from 'react'

import {
  choiceValue,
  idleTtlChoices,
  isSamePolicy,
  limitOfChoice,
  maxTtlChoices,
  type LimitChoice,
} from './session-lifetime-choices.ts'
import styles from './session-lifetime.module.css'

/** What {@link useSessionLifetime} gives the section to render. */
interface SessionLifetime {
  /** The policy as the Owner has it in the form, saved or not. */
  readonly draft: RefreshPolicy.Type
  readonly idleTtlChoices: readonly LimitChoice[]
  readonly maxTtlChoices: readonly LimitChoice[]
  readonly setDraft: (draft: RefreshPolicy.Type) => void
  /** Whether Save would change anything, and no save is in flight. */
  readonly canSave: boolean
  readonly save: () => void
  readonly isSaving: boolean
  readonly error: unknown
}

/**
 * The section's logic: a draft of `client`'s refresh policy, the choices for
 * each limit (keeping the stored ones among them), and a save that PATCHes
 * the whole policy. The draft is the Owner's until they save; a refetch of
 * the clients doesn't replace it.
 */
const useSessionLifetime = (client: Client.Type): SessionLifetime => {
  const mutation = useUpdateRefreshPolicyMutation()
  const [draft, setDraft] = useState(client.refreshPolicy)
  return {
    draft,
    idleTtlChoices: idleTtlChoices(client.refreshPolicy.idleTtl),
    maxTtlChoices: maxTtlChoices(client.refreshPolicy.maxTtl),
    setDraft,
    canSave: !mutation.isPending && !isSamePolicy(draft, client.refreshPolicy),
    save: () => {
      mutation.mutate({ clientId: client.clientId, refreshPolicy: draft })
    },
    isSaving: mutation.isPending,
    error: mutation.error,
  }
}

/** One limit's labelled `<select>`. */
const LimitPicker = ({
  label,
  choices,
  limit,
  disabled,
  onPick,
}: {
  readonly label: string
  readonly choices: readonly LimitChoice[]
  readonly limit: RefreshPolicy.Type['idleTtl']
  readonly disabled: boolean
  readonly onPick: (limit: RefreshPolicy.Type['idleTtl']) => void
}): JSX.Element => {
  const selectId = useId()
  return (
    <Field label={label} htmlFor={selectId}>
      <select
        id={selectId}
        className="input-2"
        value={choiceValue(limit)}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          const picked = limitOfChoice(choices, event.target.value)
          if (Option.isSome(picked)) onPick(picked.value)
        }}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

/**
 * The grant detail's "Session lifetime" section: how long the grant's client
 * stays signed in, which the Owner can change. The policy belongs to the app,
 * not to this grant, so the section says so; a change applies to the app's
 * sign-ins the next time each refreshes.
 */
const SessionLifetimeSection = ({ client }: { readonly client: Client.Type }): JSX.Element => {
  const { draft, setDraft, canSave, save, isSaving, error, ...choices } = useSessionLifetime(client)
  const titleId = useId()
  return (
    <section className={styles['session-lifetime']} aria-labelledby={titleId}>
      <h3 id={titleId} className="text-label-3">
        Session lifetime
      </h3>
      <p className="text-body-3">
        How long {client.name} stays signed in. These limits belong to the app, so they cover every
        approval and device it holds, not just this one. A change takes effect the next time the app
        refreshes its sign-in.
      </p>
      <Checkbox
        label="Sign out when the browser session that signed it in ends"
        checked={draft.endsWithBrowserSession}
        disabled={isSaving}
        onChange={(endsWithBrowserSession) => {
          setDraft({ ...draft, endsWithBrowserSession })
        }}
      />
      <LimitPicker
        label="Sign out after unused for"
        choices={choices.idleTtlChoices}
        limit={draft.idleTtl}
        disabled={isSaving}
        onPick={(idleTtl) => {
          setDraft({ ...draft, idleTtl })
        }}
      />
      <LimitPicker
        label="Sign out after at most"
        choices={choices.maxTtlChoices}
        limit={draft.maxTtl}
        disabled={isSaving}
        onPick={(maxTtl) => {
          setDraft({ ...draft, maxTtl })
        }}
      />
      <ErrorBanner error={error} />
      <button
        type="button"
        className={`button-2 filled ${styles['session-lifetime__save']}`}
        disabled={!canSave}
        onClick={save}
      >
        Save
      </button>
    </section>
  )
}

export { SessionLifetimeSection }
