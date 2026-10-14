import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { BrandBar } from '@wildflowerhealthio/branding-react'
import { PageLoading } from '@wildflowerhealthio/react-tundraish'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  type TelemetryConsentGateProps,
  useConsentedTelemetryStart,
} from '@wildflowerhealthio/telemetry-react'
import { Suspense, use, useRef, useState, type JSX, type ReactNode } from 'react'

/** Props for {@link ConsentedEntryRoot}. */
interface ConsentedEntryRootProps {
  /**
   * The page's boot: builds the app tree (`buildAppTree`) after redeeming the
   * sign-in the page returned with, if any. Called once, after the user has
   * answered the telemetry consent dialog.
   */
  readonly bootApp: () => Promise<ReactNode>
}

/** Renders the app tree `bootedApp` resolves to, suspending until it does. */
function BootedApp({ bootedApp }: { readonly bootedApp: Promise<ReactNode> }): ReactNode {
  return use(bootedApp)
}

/**
 * What the page shows while `bootApp` runs: the slim `BrandBar` over one
 * loading line, as on a SMART app's launch page. A return leg's sign-in is
 * redeemed over the network in that time.
 */
function BootLoading(): JSX.Element {
  return (
    <>
      <BrandBar />
      <main>
        <PageLoading />
      </main>
    </>
  )
}

/**
 * The root `main-web` mounts: the telemetry consent gate, then the app.
 *
 * @remarks
 * **Nothing boots before the user answers.** Until an answer for
 * `TELEMETRY_CONSENT_COPY.version` is stored in the page's `localStorage`, the page is the
 * consent dialog alone: `bootApp` has not run, so no sign-in is redeemed, no
 * router, query client or runtime exists, and Sentry has not started. A stored answer is handed to the gate's `onDecided` in the first
 * commit, as a new one is on Continue; either way the answer starts telemetry
 * (reporting to the `VITE_SENTRY_DSN_LAUNCHER_WEB` project, tagged
 * `app: launcher-web`) and only then calls `bootApp`, once,
 * so a persisted yes has Sentry and the tracer provider running before the
 * router and runtime are built. Until the boot resolves, the page is the brand
 * bar over a loading line. Later answers (the Telemetry row in settings
 * reopens the dialog) start or narrow telemetry and leave the app mounted. A
 * boot that fails is reported by the boundary around it.
 */
function ConsentedEntryRoot({ bootApp }: ConsentedEntryRootProps): JSX.Element {
  const { startTelemetry } = useConsentedTelemetryStart({
    dsn: import.meta.env.VITE_SENTRY_DSN_LAUNCHER_WEB ?? '',
    tags: { app: 'launcher-web' },
  })
  // StrictMode runs the gate's layout effect twice on mount; the sign-in
  // redemption in `bootApp` spends a single-use code, so it runs once.
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
      <CrashReportingBoundary extraContext={{ app: 'launcher-web' }}>
        {bootedApp === undefined ? null : (
          <Suspense fallback={<BootLoading />}>
            <BootedApp bootedApp={bootedApp} />
          </Suspense>
        )}
      </CrashReportingBoundary>
    </TelemetryConsentGate>
  )
}

export { ConsentedEntryRoot, type ConsentedEntryRootProps }
