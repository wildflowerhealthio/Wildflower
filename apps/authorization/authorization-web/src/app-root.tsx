import type { HttpClient } from '@effect/platform'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, type RouterHistory } from '@tanstack/react-router'
import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { BrandBar } from '@wildflowerhealthio/branding-react'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  TelemetryStatusControl,
  useConsentedTelemetryStart,
  useTelemetryConsentControls,
  type TelemetryConsentGateProps,
} from '@wildflowerhealthio/telemetry-react'
import type { Layer } from 'effect'
import { Suspense, use, useRef, useState, type JSX, type ReactNode } from 'react'

import { authorizationWebTelemetry } from './config.ts'
import { Landing, type LandingProps } from './landing.tsx'
import { buildRouterContext } from './router-context.ts'
import { buildRouter } from './router.ts'
import { buildSessionQueryClient } from './session-expiry.ts'
import type { ServerSession } from './sign-in.ts'

/**
 * The telemetry status control, reading the answer out of the surrounding
 * `TelemetryConsentGate` and reopening its dialog when pressed.
 */
function ConsentStatusControl(): JSX.Element {
  const { consent, reopen } = useTelemetryConsentControls()
  return <TelemetryStatusControl consent={consent} copy={TELEMETRY_CONSENT_COPY} onPress={reopen} />
}

/** Props for {@link SignedInApp}. */
interface SignedInAppProps {
  readonly session: ServerSession
  readonly history: RouterHistory
  /** The served directory, the router's basepath. */
  readonly basepath: string
  /** The transport every API request goes out over: `FetchHttpClient.layer`, or a stub in tests. */
  readonly transport: Layer.Layer<HttpClient.HttpClient>
  /** Called when a request ends in a 401: the bearer expired or was revoked. */
  readonly onSessionExpired: () => void
}

/**
 * The signed-in app: `BrandBar`, with the telemetry status control at its
 * end, over the access pages, whose requests go to the session's server with
 * its bearer. The query client and router are built once, for the page's one
 * session; a 401 on any request calls `onSessionExpired`.
 */
function SignedInApp({
  session,
  history,
  basepath,
  transport,
  onSessionExpired,
}: SignedInAppProps): JSX.Element {
  const [{ router, queryClient }] = useState(() => {
    const context = buildRouterContext(
      session,
      transport,
      buildSessionQueryClient(onSessionExpired)
    )
    return { router: buildRouter({ history, basepath, context }), queryClient: context.queryClient }
  })
  return (
    <QueryClientProvider client={queryClient}>
      <BrandBar trailing={<ConsentStatusControl />} />
      <CrashReportingBoundary extraContext={{ app: authorizationWebTelemetry.app }}>
        <RouterProvider router={router} />
      </CrashReportingBoundary>
    </QueryClientProvider>
  )
}

/** The signed-out app: the landing, with the telemetry status control above its footer. */
function SignedOutApp(props: Omit<LandingProps, 'aboveFooter'>): JSX.Element {
  return (
    <CrashReportingBoundary extraContext={{ app: authorizationWebTelemetry.app }}>
      <Landing {...props} aboveFooter={<ConsentStatusControl />} />
    </CrashReportingBoundary>
  )
}

/** Renders the tree `bootedApp` resolves to, suspending until it does. */
function BootedApp({ bootedApp }: { readonly bootedApp: Promise<ReactNode> }): ReactNode {
  return use(bootedApp)
}

/**
 * The root `main` mounts: the telemetry consent gate, then the app.
 *
 * **Nothing boots before the visitor answers.** Until an answer is stored,
 * the page is the consent dialog alone: `bootApp` has not run, so no sign-in
 * is redeemed. The answer starts telemetry (the
 * `VITE_SENTRY_DSN_AUTHORIZATION_WEB` project, tagged
 * `app: authorization-web`) and then calls `bootApp`, once: StrictMode runs
 * the gate's layout effect twice, and the redemption spends a single-use code.
 */
function ConsentedEntryRoot({
  bootApp,
}: {
  readonly bootApp: () => Promise<ReactNode>
}): JSX.Element {
  const { startTelemetry } = useConsentedTelemetryStart({
    dsn: authorizationWebTelemetry.dsn,
    tags: { app: authorizationWebTelemetry.app },
  })
  const bootStarted = useRef(false)
  const [bootedApp, setBootedApp] = useState<Promise<ReactNode>>()

  const startTelemetryThenBoot: TelemetryConsentGateProps['onDecided'] = (consent) => {
    startTelemetry(consent)
    if (bootStarted.current) return
    bootStarted.current = true
    setBootedApp(bootApp())
  }

  return (
    <TelemetryConsentGate copy={TELEMETRY_CONSENT_COPY} onDecided={startTelemetryThenBoot}>
      {bootedApp === undefined ? null : (
        <Suspense fallback={null}>
          <BootedApp bootedApp={bootedApp} />
        </Suspense>
      )}
    </TelemetryConsentGate>
  )
}

export { ConsentedEntryRoot, SignedInApp, SignedOutApp }
export type { SignedInAppProps }
