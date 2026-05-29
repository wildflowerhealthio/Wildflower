import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, ItemList, pageLayoutStyles } from 'react-tundraish'

import { formatInstant } from '../../../format-date.ts'
import {
  requestsQueryOptions,
  useDecideRequestMutation,
  useRequestsQuery,
  type HttpRequest,
} from '../../../queries.ts'
import { ensureAuthedQuery } from '../../../router-loader.ts'
import pageLayout from '../../../styles/page-layout.module.css'

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface RequestsListBodyProps {
  readonly requests: readonly HttpRequest[]
}

const RequestsListBody = ({ requests }: RequestsListBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const decideMutation = useDecideRequestMutation()
  const errorMessage = decideMutation.error === null ? null : formatError(decideMutation.error)

  const decide = (id: string, decision: 'approved' | 'rejected'): void => {
    decideMutation.mutate({ id, decision })
  }

  const toItem = (
    r: HttpRequest
  ): {
    id: string
    title: string
    subtitle: string
    onClick: () => void
    actions?: JSX.Element
  } => ({
    id: r.id,
    title: `${r.method} ${r.url}`,
    subtitle:
      r.origin !== ''
        ? `${r.origin} · ${formatInstant(r.requestedAt)}`
        : formatInstant(r.requestedAt),
    onClick: () => {
      void navigate({ to: `/settings/gatekeeper/requests/${encodeURIComponent(r.id)}` })
    },
    actions:
      r.status === 'pending' ? (
        <div className={pageLayout['row-actions']}>
          <button
            type="button"
            className="button-2 filled"
            disabled={decideMutation.isPending}
            onClick={(e) => {
              e.stopPropagation()
              decide(r.id, 'approved')
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="button-2 filled accent-red"
            disabled={decideMutation.isPending}
            onClick={(e) => {
              e.stopPropagation()
              decide(r.id, 'rejected')
            }}
          >
            Reject
          </button>
        </div>
      ) : undefined,
  })

  const pending = requests.filter((r) => r.status === 'pending')
  const approved = requests.filter((r) => r.status === 'approved')
  const rejected = requests.filter((r) => r.status === 'rejected')

  return (
    <div className={pageLayoutStyles['page']}>
      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}
      <ItemList title="In-Flight" items={pending.map((r) => toItem(r))} />
      <ItemList title="Approved" items={approved.map((r) => toItem(r))} />
      <ItemList title="Rejected" items={rejected.map((r) => toItem(r))} />
    </div>
  )
}

const RequestsListScreen = (): JSX.Element => {
  const { data: requests } = useRequestsQuery()
  return <RequestsListBody requests={requests} />
}

/**
 * The `/settings/gatekeeper/requests` file route — the incoming HTTP
 * request history. See {@link ensureAuthedQuery} for the loader's
 * token-ready guard and error-propagation contract.
 */
export const Route = createFileRoute('/settings/gatekeeper/requests')({
  loader: ({ context }) => ensureAuthedQuery(context, requestsQueryOptions(context.runAuthed)),
  component: RequestsListScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Requests" />,
})
