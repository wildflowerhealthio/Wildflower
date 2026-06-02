import { createFileRoute } from '@tanstack/react-router'
import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, pageLayoutStyles, StatusBadge, type StatusTone } from 'react-tundraish'

import { formatInstant } from '../../../format-date.ts'
import {
  requestQueryOptions,
  useDecideRequestMutation,
  useRequestQuery,
  type HttpRequest,
} from '../../../queries/index.ts'
import pageLayout from '../../../styles/page-layout.module.css'

const statusTone = (status: string): StatusTone => {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  if (status === 'pending') return 'warning'
  return 'neutral'
}

interface RequestDetailBodyProps {
  readonly request: HttpRequest
  readonly id: string
}

const RequestDetailBody = ({ request, id }: RequestDetailBodyProps): JSX.Element => {
  const decideMutation = useDecideRequestMutation()
  const errorMessage =
    decideMutation.error === null ? null : unknownErrorToString(decideMutation.error)

  const decide = (decision: 'approved' | 'rejected'): void => {
    decideMutation.mutate({ id, decision })
  }

  return (
    <div className={pageLayoutStyles['page']}>
      <div className={pageLayout['section']}>
        <h2 className="text-label-3">{request.method}</h2>
        <h1 className="text-heading-4">{request.url}</h1>
      </div>

      <StatusBadge tone={statusTone(request.status)}>{request.status.toUpperCase()}</StatusBadge>

      <div className={pageLayout['section']}>
        <strong className="text-label-3">Request</strong>
        <span className="text-body-3">Received: {formatInstant(request.requestedAt)}</span>
        {request.origin !== '' ? (
          <span className="text-body-3">Origin: {request.origin}</span>
        ) : null}
        {request.userAgent !== '' ? (
          <span className="text-body-3">User-Agent: {request.userAgent}</span>
        ) : null}
      </div>

      {request.respondedAt !== null ? (
        <div className={pageLayout['section']}>
          <strong className="text-label-3">Response</strong>
          <span className="text-body-3">Responded: {formatInstant(request.respondedAt)}</span>
          {request.statusCode !== null ? (
            <span className="text-body-3">Status: {request.statusCode}</span>
          ) : null}
        </div>
      ) : null}

      {request.status === 'pending' ? (
        <div className={pageLayout['buttons']}>
          <button
            type="button"
            className="button-2 filled"
            disabled={decideMutation.isPending}
            onClick={() => {
              decide('approved')
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="button-2 filled accent-red"
            disabled={decideMutation.isPending}
            onClick={() => {
              decide('rejected')
            }}
          >
            Reject
          </button>
        </div>
      ) : null}

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}

const RequestDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const { data: request } = useRequestQuery(id)
  return <RequestDetailBody request={request} id={id} />
}

/**
 * The `/settings/gatekeeper/requests/$id` file route — the standalone
 * request-detail screen the list navigates to. The filename's trailing
 * underscore (`requests_`) opts this route OUT of nesting under the
 * `requests` list route (which renders no `<Outlet />`), so the detail
 * replaces the list at this URL instead of being swallowed. The URL keeps
 * the bare `/requests/` segment — only the route id carries `requests_`.
 *
 * Reads the typed `$id` path param via `Route.useParams()` and hands it to
 * the screen as a prop. The `/settings` `beforeLoad` gate guarantees a
 * token before this loader runs, so it's a plain `ensureQueryData` —
 * failures propagate to `errorComponent`.
 */
function RequestDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <RequestDetailScreen id={id} />
}

export const Route = createFileRoute('/settings/gatekeeper/requests_/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(requestQueryOptions(context.runAuthed, params.id)),
  component: RequestDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Not Found" />,
})
