import { unknownErrorToString } from 'kitchen-sink'
import { useState } from 'react'

import {
  useTunnelReplaceMutation,
  type RelayInput,
  type TunnelReplaceInput,
  type TunnelState,
} from './queries.ts'
import { useFieldDraft } from './use-field-draft.ts'

/** The write-only relay fields, in wire order. */
const RELAY_KEYS = ['remoteAddr', 'token', 'publicKey', 'serviceName'] as const
type RelayKey = (typeof RELAY_KEYS)[number]

/** Dirtiness ignores incidental whitespace; the baseline is already trimmed. */
const trimEquals = (draftValue: string, baselineValue: string): boolean =>
  draftValue.trim() === baselineValue

/**
 * Empty input maps to `null` so clearing `publicHost` becomes an explicit
 * `null` write (the wire schema is present-but-nullable).
 */
const normalizeOptionalString = (raw: string): string | null => {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

export interface TunnelSettingsForm {
  readonly hostInput: string
  readonly setHostInput: (value: string) => void
  readonly relay: Record<RelayKey, string>
  readonly setRelayField: (key: RelayKey, value: string) => void
  readonly relayInvalid: boolean
  readonly conflicted: boolean
  readonly pending: boolean
  readonly errorMessage: string | null
  readonly canSave: boolean
  readonly save: () => void
  readonly toggle: (requestedRunning: boolean) => void
}

/**
 * All of the tunnel settings form's behavior — the editable drafts and their
 * server reconciliation, dirty/validation, the conflict signal, and the save /
 * toggle policy — so the screen component stays presentational.
 *
 * The host and relay are each a {@link useFieldDraft} over the latest server
 * snapshot, so an unsaved edit survives an unrelated revision bump (e.g. a
 * toggle) while a genuine conflict rebases. The relay `token` is write-only:
 * its baseline is always `''`, so it's never echoed into the draft and only a
 * fresh token counts as a relay change.
 */
export const useTunnelSettingsForm = (state: TunnelState): TunnelSettingsForm => {
  const replaceMutation = useTunnelReplaceMutation()

  const host = useFieldDraft(['publicHost'], { publicHost: state.publicHost ?? '' }, trimEquals)
  const relay = useFieldDraft(
    RELAY_KEYS,
    {
      remoteAddr: state.relay?.remoteAddr ?? '',
      token: '',
      publicKey: state.relay?.publicKey ?? '',
      serviceName: state.relay?.serviceName ?? '',
    },
    trimEquals
  )

  // Unresolved-conflict signal. Tracked explicitly (not derived from
  // `mutation.data`) so it survives an unrelated toggle and only clears when the
  // user re-saves (Applied) or makes a fresh host edit.
  const [conflicted, setConflicted] = useState(false)

  const pending = replaceMutation.isPending
  const errorMessage =
    replaceMutation.error === null ? null : unknownErrorToString(replaceMutation.error)

  const hostDirty = host.dirty
  const relayDirty = relay.dirty
  // A relay change is all-or-nothing and must carry a fresh token (the stored
  // one is never echoed back), so a dirtied-but-incomplete relay is invalid.
  const relayComplete = RELAY_KEYS.every((key) => relay.fields[key].trim() !== '')
  const relayInvalid = relayDirty && !relayComplete

  const canSave = !pending && !relayInvalid && (hostDirty || relayDirty)

  const setHostInput = (value: string): void => {
    host.setField('publicHost', value)
    // Editing the host acknowledges the refreshed values and is a fresh,
    // non-stale decision — so dismiss the conflict banner.
    if (conflicted) setConflicted(false)
  }

  const toggle = (requestedRunning: boolean): void => {
    // A toggle never touches host/relay — the mutation fills those from the
    // freshest cached snapshot. A toggle that itself 409s raises the banner, but
    // an Applied toggle never *clears* it (it doesn't resolve a host conflict).
    replaceMutation.mutate(
      { requestedRunning },
      {
        onSuccess: (result) => {
          if (result._tag === 'Conflict') setConflicted(true)
        },
      }
    )
  }

  const save = (): void => {
    const trimmedRelay: RelayInput = {
      remoteAddr: relay.fields.remoteAddr.trim(),
      token: relay.fields.token.trim(),
      publicKey: relay.fields.publicKey.trim(),
      serviceName: relay.fields.serviceName.trim(),
    }
    const input: TunnelReplaceInput = {
      publicHost: normalizeOptionalString(host.fields.publicHost),
      ...(relayDirty ? { relay: trimmedRelay } : {}),
    }
    replaceMutation.mutate(input, {
      onSuccess: (result) => {
        setConflicted(result._tag === 'Conflict')
        // Applied: the relay write landed and its token is now stored, so blank
        // the write-only token input. On a Conflict no write happened — keep the
        // typed relay (incl. token) so a re-Save still carries it; any changed-
        // elsewhere fields are rebased by useFieldDraft.
        if (result._tag === 'Applied' && relayDirty) relay.setField('token', '')
      },
    })
  }

  return {
    hostInput: host.fields.publicHost,
    setHostInput,
    relay: relay.fields,
    setRelayField: relay.setField,
    relayInvalid,
    conflicted,
    pending,
    errorMessage,
    canSave,
    save,
    toggle,
  }
}
