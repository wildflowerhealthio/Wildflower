import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { type JSX, useState } from 'react'
import {
  ConfirmDialog,
  ErrorBanner,
  GateCard,
  ItemList,
  PageBodyError,
  PageHeader,
} from 'react-tundraish'
import type { CertificateAuthority, ListedServer } from 'servers-core'

import { failureText } from './failure-text.ts'
import { serversQueryOptions, useRemoveServer } from './queries.ts'
import type { RouterContext, RunHostCommand } from './router-context.ts'
import styles from './server-page.module.css'

/** What the Relay row says of each kind of relay. */
const relayText = (relay: ListedServer.Relay): string => {
  if (relay.kind === 'selfHostedWildflower') {
    return `Self-hosted Wildflower relay at ${relay.baseUrl}`
  }
  return relay.kind === 'wildflowerOfficial' ? 'Wildflower relay' : 'Rathole server'
}

/** What the Certificates row says of each CA. */
const CERTIFICATE_AUTHORITY_TEXT: Readonly<Record<CertificateAuthority.Type, string>> = {
  letsEncrypt: "Let's Encrypt",
  letsEncryptStaging: "Let's Encrypt staging, which browsers don't trust",
}

/** The server's details, and its removal behind a confirm, which returns to the list. */
const ServerDetails = ({
  server,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const navigate = useNavigate()
  const removeServer = useRemoveServer(runHostCommand)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  return (
    <>
      <ItemList
        title="Details"
        maxLines={3}
        items={[
          { id: 'relay', title: 'Relay', subtitle: relayText(server.relay) },
          { id: 'tunnel-name', title: 'Tunnel name', subtitle: server.tunnelName },
          { id: 'launcher', title: 'Launcher', subtitle: server.launcherUrl },
          {
            id: 'certificates',
            title: 'Certificates',
            subtitle: CERTIFICATE_AUTHORITY_TEXT[server.certificateAuthority],
          },
        ]}
      />
      <ErrorBanner error={removeServer.error === null ? null : failureText(removeServer.error)} />
      <button
        type="button"
        className={`button-2 outline accent-red ${styles['server-page__remove']}`}
        onClick={() => {
          setConfirmingRemoval(true)
        }}
      >
        Remove
      </button>
      <ConfirmDialog
        open={confirmingRemoval}
        title={`Remove ${server.domain}?`}
        confirmLabel="Remove"
        destructive
        pending={removeServer.isPending}
        onConfirm={() => {
          removeServer.mutate(
            { domain: server.domain },
            {
              onSuccess: () => {
                void navigate({ to: '/' })
              },
              onSettled: () => {
                setConfirmingRemoval(false)
              },
            }
          )
        }}
        onCancel={() => {
          setConfirmingRemoval(false)
        }}
      >
        This stops the server and deletes it from this device, with its databases and certificates.
        It can't be undone.
      </ConfirmDialog>
    </>
  )
}

/**
 * A server's page, `/servers/$domain`, opened by its card's Edit: its relay,
 * tunnel name, launcher and certificates, read-only, and its removal.
 *
 * @remarks
 * The server is read from the same cached list as the server list, so a
 * domain the list doesn't hold says so, with the way back.
 */
const ServerPage = ({ domain }: { readonly domain: string }): JSX.Element => {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const servers = useQuery(serversQueryOptions(runHostCommand))
  const header = <PageHeader title="Server" subtitle={domain} backHref="/" backLabel="Servers" />
  if (servers.isPending) {
    return (
      <>
        {header}
        <GateCard title="Reading the servers on this device…" />
      </>
    )
  }
  if (servers.isError) {
    return (
      <>
        {header}
        <PageBodyError
          title="The servers on this device couldn't be read"
          error={servers.error}
          retry={() => {
            void servers.refetch()
          }}
        />
      </>
    )
  }
  const server = servers.data.find((listed) => listed.domain === domain)
  return (
    <>
      {header}
      {server === undefined ? (
        <GateCard title="This device has no server at this address." />
      ) : (
        <ServerDetails server={server} runHostCommand={runHostCommand} />
      )}
    </>
  )
}

export { ServerPage }
