import { ErrorBoundary, type ErrorBoundaryProps } from '@wildflowerhealthio/react-tundraish'
import { Sentry } from '@wildflowerhealthio/telemetry-web'
import type { JSX, ReactNode } from 'react'

/** Props for {@link CrashReportingBoundary}. */
interface CrashReportingBoundaryProps {
  /**
   * What the fallback's context pane shows beside the build mode: which app
   * (`{ app }`) or entry (`{ entry }`) crashed.
   */
  readonly extraContext: Readonly<Record<string, string>>
  /** The fallback title's heading level: 2 where the page already has its h1. */
  readonly headingLevel?: ErrorBoundaryProps['headingLevel']
  readonly children: ReactNode
}

/**
 * A `react-tundraish` `ErrorBoundary` that reports what it catches, with its
 * component stack, through `Sentry.captureException`.
 *
 * @remarks
 * Reports without asking about consent: `captureException` does nothing
 * while Sentry has not been initialized, which `initConsentedTelemetry` never
 * does without a yes, and the SDK's `beforeSend` drops errors once crash
 * reports are turned off.
 */
const CrashReportingBoundary = ({
  extraContext,
  headingLevel,
  children,
}: CrashReportingBoundaryProps): JSX.Element => (
  <ErrorBoundary
    headingLevel={headingLevel}
    onError={(error, info) => {
      Sentry.captureException(error, {
        extra: { componentStack: info.componentStack ?? undefined },
      })
    }}
    extraContext={{ mode: import.meta.env.MODE, ...extraContext }}
  >
    {children}
  </ErrorBoundary>
)

export { CrashReportingBoundary, type CrashReportingBoundaryProps }
