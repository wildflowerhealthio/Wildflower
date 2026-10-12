import { createFileRoute, useLoaderData } from '@tanstack/react-router'
import { PageBodyError, pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import { RecorderPage } from '@wildflowerhealthio/recorder-react'
import { CrashReportingBoundary } from '@wildflowerhealthio/telemetry-react'
import { Match } from 'effect'
import type { JSX } from 'react'

/**
 * The Recorder page, over the recording the host's layout keeps
 * (`RecorderSession`), or why its transport couldn't connect.
 */
function RecorderRoute(): JSX.Element {
  const connection = useLoaderData({ from: '__root__' })
  const page = Route.useRouteContext({ select: (context) => context.recorderPage })
  return Match.value(connection).pipe(
    Match.tag('Connected', () => (
      <CrashReportingBoundary extraContext={{ page: 'recorder' }}>
        <RecorderPage {...page} />
      </CrashReportingBoundary>
    )),
    Match.tag('Failed', ({ error }) => (
      <div className={pageLayoutStyles['page']}>
        <PageBodyError title="The recorder couldn't connect" error={error} />
      </div>
    )),
    Match.exhaustive
  )
}

/** `/recorder`, the Recorder. */
export const Route = createFileRoute('/recorder')({ component: RecorderRoute })
