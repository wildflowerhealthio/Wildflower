import { createFileRoute } from '@tanstack/react-router'
import { ErrorBanner, ItemList, TextField } from '@wildflowerhealthio/react-tundraish'
import {
  HostCommandFailed,
  type HostCommandError,
  type ListedServer,
} from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import { type JSX, useState } from 'react'

import { failureText } from '../../../failure-text.ts'
import { useSetServerCredentials } from '../../../queries.ts'
import { useRunHostCommand } from '../../../router-context.ts'
import { useListedServer } from './-listed-server.ts'
import styles from './-relay.module.css'

/** What the Relay row says of each kind of relay. */
const relayText = (relay: ListedServer.Relay): string => {
  if (relay.kind === 'selfHostedWildflower') {
    return `Self-hosted Wildflower relay at ${relay.baseUrl}`
  }
  return relay.kind === 'wildflowerOfficial' ? 'Wildflower relay' : 'Rathole server'
}

/**
 * Whether the host refused a new token because the relay no longer presents
 * the identity the server was added with.
 */
const isRelayIdentityChange = (error: HostCommandError): boolean =>
  error instanceof HostCommandFailed &&
  error.refusal.pipe(Option.exists((refusal) => refusal.kind === 'relayIdentityChanged'))

/**
 * The warning, in place of the host's refusal, that the relay's identity has
 * changed since the server was added: the host's `message`, which names the
 * setting and both values and says the relay may be impersonated, and what
 * to do. It offers no retry, as a token sent again meets the same identity.
 */
const RelayIdentityWarning = ({ message }: { readonly message: string }): JSX.Element => (
  <div className={styles['relay__identity-warning']} role="alert">
    <p className={`text-label-2 ${styles['relay__identity-warning-title']}`}>
      The relay's identity has changed
    </p>
    <p className={`text-body-3 ${styles['relay__identity-warning-detail']}`}>{message}</p>
    <p className="text-body-3">
      If whoever runs the relay confirms it changed, remove this server and add it again.
    </p>
  </div>
)

/** Why the host refused a new token. */
interface TokenRefusal {
  /** The host's message. */
  readonly message: string
  /**
   * Whether the relay no longer presents the identity the server was added
   * with, a warning rather than a failure to retry.
   */
  readonly relayIdentityChanged: boolean
}

/** A {@link CredentialsForm}'s state and what it can do. */
interface TokenFormState {
  /** The token in the field, which starts empty. */
  readonly token: string
  readonly setToken: (token: string) => void
  /** Whether there is a token to send and no send is in flight. */
  readonly canSave: boolean
  /** The host's refusal of the latest token. */
  readonly refusal: Option.Option<TokenRefusal>
  /** Sends the token, clearing the field once the host accepts it. */
  readonly save: () => void
}

/** The state of the form that replaces the token of the server `domain`'s tunnel. */
const useTokenForm = (domain: string): TokenFormState => {
  const setCredentials = useSetServerCredentials(useRunHostCommand())
  const [token, setToken] = useState('')
  return {
    token,
    setToken,
    canSave: token.trim() !== '' && !setCredentials.isPending,
    refusal: Option.fromNullable(setCredentials.error).pipe(
      Option.map((error) => ({
        message: failureText(error),
        relayIdentityChanged: isRelayIdentityChange(error),
      }))
    ),
    save: () => {
      setCredentials.mutate(
        { domain, token },
        {
          onSuccess: () => {
            setToken('')
          },
        }
      )
    },
  }
}

/**
 * The form that replaces the token the server's tunnel signs in to its
 * relay with (see {@link useTokenForm}). The field starts empty and the
 * stored token is never shown; it clears once the host accepts the new one,
 * and the host's refusal shows under it, or, when the relay's identity has
 * changed, a warning that says so.
 */
const CredentialsForm = ({ domain }: { readonly domain: string }): JSX.Element => {
  const form = useTokenForm(domain)
  return (
    <form
      className={styles['relay__form']}
      onSubmit={(event) => {
        event.preventDefault()
        form.save()
      }}
    >
      <TextField
        label="New tunnel token"
        type="password"
        value={form.token}
        onChange={form.setToken}
        autoComplete="off"
        description="The relay checks it before it is saved, and the server starts again with it."
      />
      {form.refusal.pipe(
        Option.filter(({ relayIdentityChanged }) => relayIdentityChanged),
        Option.map(({ message }) => <RelayIdentityWarning key="identity" message={message} />),
        Option.getOrNull
      )}
      <ErrorBanner
        error={form.refusal.pipe(
          Option.filter(({ relayIdentityChanged }) => !relayIdentityChanged),
          Option.map(({ message }) => message),
          Option.getOrNull
        )}
      />
      <button
        type="submit"
        className={`button-2 outline ${styles['relay__form-action']}`}
        disabled={!form.canSave}
      >
        Save token
      </button>
    </form>
  )
}

/**
 * The server page's Relay tab, `/servers/$domain/relay`: the server's relay
 * and tunnel name, and the form that replaces its token.
 */
const ServerRelayTab = (): JSX.Element => {
  const server = useListedServer()
  return (
    <>
      <ItemList
        title="Relay and tunnel"
        maxLines={3}
        items={[
          { id: 'relay', title: 'Relay', subtitle: relayText(server.relay) },
          { id: 'tunnel-name', title: 'Tunnel name', subtitle: server.tunnelName },
        ]}
      />
      <CredentialsForm domain={server.domain} />
    </>
  )
}

export const Route = createFileRoute('/servers/$domain/relay')({
  component: ServerRelayTab,
})
