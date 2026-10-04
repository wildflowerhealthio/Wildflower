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
  /** That the answer can be changed later, and where. */
  readonly changeLater: string
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
  title: 'Demo apps and telemetry',
  warning: [
    'These are demo apps from the Wildflower Health Project. ' +
      'Use them only with synthetic or test data.',
    "Never connect them to a real person's health record.",
  ],
  destination:
    'The two switches below choose what, if anything, these apps report to Sentry, ' +
    'a third-party service in the United States. Both switches start off, ' +
    'and with both off nothing is sent.',
  crashReports: {
    label: 'Crash reports',
    description:
      'When the app runs into an error, it sends a report of the error. ' +
      'A report can include anything the app had loaded at the time, including ' +
      'names, medications, results, record ids and server addresses.',
  },
  performance: {
    label: 'Performance data',
    description:
      'Sends anonymized timings: how long pages and requests take, with the names of ' +
      'the pages and of the resource types requested. Record ids and query strings ' +
      'are removed first, and no record contents are sent.',
  },
  sessions:
    'While either switch is on, Sentry also counts app sessions. A session records that ' +
    'the app was opened, whether it ran into an error, and the browser and operating ' +
    'system it ran on. Sessions carry no page addresses or record data.',
  changeLater:
    'You can change your answer at any time with the Telemetry button at the top or ' +
    'bottom of the page.',
  continueLabel: 'Continue',
}

/**
 * The telemetry consent dialog's copy for Wildflower Host, the desktop and
 * mobile app whose webview runs the owner UI (`apps/wildflower-tauri`).
 *
 * @remarks
 * The same dialog as {@link TELEMETRY_CONSENT_COPY}, worded for one app that
 * keeps what it loads on the device rather than for a set of web apps: the
 * warning says so, the session counts name no browser, and the answer is
 * changed from the Settings screen rather than a button on the page. The
 * switch labels are the shared ones, so the Telemetry row in Settings reads
 * the same on every entry. Its answer is stored in the webview's own
 * storage, under this copy's `version`, apart from any web app's.
 */
const WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY: TelemetryConsentCopy = {
  version: 1,
  title: 'Demo app and telemetry',
  warning: [
    'Wildflower Host is a demo app from the Wildflower Health Project. ' +
      'It keeps the records you load in it on this device.',
    "Load synthetic data only. Never load a real person's health record.",
  ],
  destination:
    'The two switches below choose what, if anything, this app reports to Sentry, ' +
    'a third-party service in the United States. Both switches start off, ' +
    'and with both off nothing is sent.',
  crashReports: {
    label: TELEMETRY_CONSENT_COPY.crashReports.label,
    description:
      'When the app runs into an error, it sends a report of the error. ' +
      'A report can include anything the app had loaded at the time, including ' +
      'names, medications, results, record ids and server addresses.',
  },
  performance: TELEMETRY_CONSENT_COPY.performance,
  sessions:
    'While either switch is on, Sentry also counts app sessions. A session records that ' +
    'the app was opened, whether it ran into an error, and the operating system it ' +
    'ran on. Sessions carry no page addresses or record data.',
  changeLater: 'You can change your answer at any time with the Telemetry row in Settings.',
  continueLabel: TELEMETRY_CONSENT_COPY.continueLabel,
}

export { TELEMETRY_CONSENT_COPY, WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY }
export type { TelemetryConsentCopy }
