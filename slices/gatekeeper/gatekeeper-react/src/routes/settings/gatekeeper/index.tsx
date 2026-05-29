import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, ItemList, Menu, pageLayoutStyles, type MenuItem } from 'react-tundraish'

import { RevokeGrantDialog } from '../../../components/RevokeGrantDialog.tsx'
import { formatInstant } from '../../../format-date.ts'
import {
  grantsQueryOptions,
  useGrantsQuery,
  useRevokeGrantMutation,
  type Grant,
} from '../../../queries.ts'
import { ensureAuthedQuery } from '../../../router-loader.ts'

interface AccessIndexBodyProps {
  readonly grants: readonly Grant[]
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const AccessIndexBody = ({ grants }: AccessIndexBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const revokeMutation = useRevokeGrantMutation()
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  const errorMessage = revokeMutation.error === null ? null : formatError(revokeMutation.error)

  const revoke = (id: string): void => {
    revokeMutation.mutate(
      { id },
      {
        onSuccess: () => {
          setConfirmRevokeId(null)
        },
      }
    )
  }

  const grantToRevoke = grants.find((g) => g.id === confirmRevokeId) ?? null

  return (
    <div className={pageLayoutStyles['page']}>
      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <ItemList
        title="Requests"
        items={[
          {
            id: 'requests',
            title: 'HTTP Requests',
            subtitle: 'View incoming request history',
            onClick: () => {
              void navigate({ to: '/settings/gatekeeper/requests' })
            },
          },
        ]}
      />

      {grants.length > 0 ? (
        <ItemList
          title="Approved Apps"
          items={grants.map((grant) => ({
            id: grant.id,
            title: grant.clientId,
            subtitle: `${grant.scopes.join(', ')} · Granted ${formatInstant(grant.grantedAt)}`,
            onClick: () => {
              void navigate({
                to: `/settings/gatekeeper/approved/${encodeURIComponent(grant.id)}`,
              })
            },
            actions: (
              <Menu
                label={`Actions for ${grant.clientId}`}
                items={
                  [
                    {
                      id: 'revoke',
                      label: 'Revoke',
                      destructive: true,
                      onSelect: () => {
                        setConfirmRevokeId(grant.id)
                      },
                    },
                  ] as readonly MenuItem[]
                }
              />
            ),
          }))}
        />
      ) : null}

      <RevokeGrantDialog
        clientId={grantToRevoke?.clientId ?? null}
        onConfirm={() => {
          if (grantToRevoke !== null) revoke(grantToRevoke.id)
        }}
        onCancel={() => {
          setConfirmRevokeId(null)
        }}
      />
    </div>
  )
}

const AccessIndexScreen = (): JSX.Element => {
  const { data: grants } = useGrantsQuery()
  return <AccessIndexBody grants={grants} />
}

/**
 * The `/settings/gatekeeper/` landing file route — the owner-facing access
 * management index.
 *
 * The `/settings` gate is a React component (`RequireAuth`), not
 * `beforeLoad`, so the loader fires before auth. {@link ensureAuthedQuery}
 * skips the prefetch when the bearer token isn't ready yet (embedded first
 * paint, before `transport.flushed`) and lets the in-component
 * `useSuspenseQuery` — rendered only after `RequireAuth` passes — do the
 * real read. Genuine read failures propagate to `errorComponent`.
 */
export const Route = createFileRoute('/settings/gatekeeper/')({
  loader: ({ context }) => ensureAuthedQuery(context, grantsQueryOptions(context.runAuthed)),
  component: AccessIndexScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Gatekeeper" />,
})
