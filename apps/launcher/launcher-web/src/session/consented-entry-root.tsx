import type { TelemetryConsentCopy } from 'branding-core'
import { Suspense, use, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  CrashReportingBoundary,
  TelemetryConsentGate,
  type TelemetryConsentGateProps,
  useConsentedTelemetryStart,
} from 'telemetry-react'

import type { RouterContext } from '../router-context.ts'

/** Props for {@link ConsentedEntryRoot}. */
interface ConsentedEntryRootProps {
  /** The entry mounting the root, set as every event's `entry` tag. */
  readonly entry: RouterContext['entry']
  /**
   * The consent dialog's words and copy version: `TELEMETRY_CONSENT_COPY` on
   * `main-web`, `WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY` on `main-tauri`.
   */
  readonly copy: TelemetryConsentCopy
  /**
   * The entry's boot: builds the app tree (`buildAppTree`), on `main-web`
   * after redeeming the sign-in the page returned with, if any. Called once,
   * after the user has answered the telemetry consent dialog.
   */
  readonly bootApp: () => Promise<ReactNode>
}

/** Renders the app tree `bootedApp` resolves to, suspending until it does. */
function BootedApp({ bootedApp }: { readonly bootedApp: Promise<ReactNode> }): ReactNode {
  return use(bootedApp)
}

/**
 * The root both launcher entries mount: the telemetry consent gate, then the
 * app.
 *
 * @remarks
 * **Nothing boots before the user answers.** Until an answer for
 * `copy.version` is stored in the page's `localStorage`, the page is the
 * consent dialog alone: `bootApp` has not run, so no sign-in is redeemed, no
 * router, query client, runtime or transport exists, and Sentry has not
 * started. A stored answer is handed to the gate's `onDecided` in the first
 * commit, as a new one is on Continue; either way the answer starts telemetry
 * (reporting to the `VITE_SENTRY_DSN_LAUNCHER_WEB` project, tagged
 * `app: wildflower-react` and `entry`) and only then calls `bootApp`, once,
 * so a persisted yes has Sentry and the tracer provider running before the
 * router and runtime are built. Later answers (the Telemetry row in settings
 * reopens the dialog) start or narrow telemetry and leave the app mounted. A
 * boot that fails is reported by the boundary around it.
 */
function ConsentedEntryRoot({ entry, copy, bootApp }: ConsentedEntryRootProps): JSX.Element {
  const { startTelemetry } = useConsentedTelemetryStart({
    dsn: import.meta.env.VITE_SENTRY_DSN_LAUNCHER_WEB ?? '',
    tags: { app: 'wildflower-react', entry },
  })
  // StrictMode runs the gate's layout effect twice on mount; the sign-in
  // redemption in `main-web`'s `bootApp` spends a single-use code, so it
  // runs once.
  const bootStarted = useRef(false)
  const [bootedApp, setBootedApp] = useState<Promise<ReactNode>>()

  const startTelemetryThenBoot: TelemetryConsentGateProps['onDecided'] = (consent) => {
    startTelemetry(consent)
    if (bootStarted.current) return
    bootStarted.current = true
    setBootedApp(bootApp())
  }

  return (
    <TelemetryConsentGate copy={copy} onDecided={startTelemetryThenBoot}>
      <CrashReportingBoundary extraContext={{ entry }}>
        {bootedApp === undefined ? null : (
          <Suspense fallback={null}>
            <BootedApp bootedApp={bootedApp} />
          </Suspense>
        )}
      </CrashReportingBoundary>
    </TelemetryConsentGate>
  )
}

export { ConsentedEntryRoot, type ConsentedEntryRootProps }
