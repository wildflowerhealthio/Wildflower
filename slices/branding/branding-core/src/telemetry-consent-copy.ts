/**
 * What one switch in the telemetry consent dialog is called and what turning
 * it on sends.
 */
interface TelemetryConsentSwitchCopy {
  /** The switch's label, also its name in the status control. */
  readonly label: string
  /** One plain paragraph saying exactly what the switch sends. */
  readonly description: string
}

/**
 * The words of the telemetry consent dialog every Wildflower web app shows
 * before it starts, and the version they are stored under.
 */
interface TelemetryConsentCopy {
  /**
   * The copy version a visitor's answer is stored with. A stored answer for
   * another version reads as undecided, so raising it asks everyone again.
   */
  readonly version: number
  /** The dialog's heading. */
  readonly title: string
  /** The synthetic-data warning, in reading order, shown first and loudest. */
  readonly warning: readonly string[]
  /** Where reports go when either switch is on. */
  readonly destination: string
  /** The crash-reports switch: errors, which may carry loaded data. */
  readonly crashReports: TelemetryConsentSwitchCopy
  /** The performance switch: anonymized timings and route names. */
  readonly performance: TelemetryConsentSwitchCopy
  /** What either switch also turns on: Sentry's session counts. */
  readonly sessions: string
  /** The one button, which records the answer whatever the switches say. */
  readonly continueLabel: string
}

/**
 * The telemetry consent dialog's copy, shared by every Wildflower web app.
 *
 * @remarks
 * The apps are demos, and a crash report can carry whatever the app had
 * loaded, so the warning comes before the switches and says plainly what not
 * to do. Each switch description names what it sends, not what it is for. Any
 * change to what the dialog promises raises `version`, so the visitors who
 * answered the old wording are asked again.
 */
const TELEMETRY_CONSENT_COPY: TelemetryConsentCopy = {
  version: 1,
  title: 'Before you start',
  warning: [
    'These are demo apps from the Wildflower Health Project. ' +
      'Use them only with synthetic or test data.',
    "Never connect them to a real person's health record.",
  ],
  destination:
    'If you turn on either switch below, reports go to Sentry, a third-party service ' +
    'hosted in the United States. Both switches start off.',
  crashReports: {
    label: 'Crash reports',
    description:
      'Sends the errors the app hits. A report may include anything the app had loaded at ' +
      'the time: names, medications, results, record ids and server addresses.',
  },
  performance: {
    label: 'Performance data',
    description:
      'Sends anonymized page loads, request timings, and route and resource-type names. ' +
      'Record ids and query strings are removed before sending. No record contents are sent.',
  },
  sessions:
    'While either switch is on, Sentry also counts app sessions. ' +
    'The counts carry no identifying information.',
  continueLabel: 'Continue',
}

export { TELEMETRY_CONSENT_COPY }
export type { TelemetryConsentCopy, TelemetryConsentSwitchCopy }
