import type { MarketingAnchor } from './nav.ts'
import { SECTION_PATHS, type SectionId } from './site.ts'

/**
 * The site sections with a standalone app landing page: the SMART on FHIR apps,
 * and the hosted Wildflower owner UI (`app`).
 */
type AppSectionId = Extract<
  SectionId,
  | 'medications'
  | 'fhirSyncPebble'
  | 'importer'
  | 'webTrace'
  | 'healthViewer'
  | 'syntheticData'
  | 'lifting'
  | 'app'
>

/**
 * The app sections the marketing homepage has a launcher row for: all but the
 * owner UI; the Synthesized Health Viewer, whose homepage row keeps its own
 * inline copy until the app is registered on the Wildflower host; the Synthetic
 * Data Loader, which has no homepage row; and Lifting, which has no homepage
 * row until it is registered there.
 */
type HomepageAppSectionId = Exclude<
  AppSectionId,
  'app' | 'healthViewer' | 'syntheticData' | 'lifting'
>

/**
 * The four SMART app sections, in the order the marketing homepage presents
 * them. The owner UI (`app`) has a landing page but no homepage row, so it is
 * not among them.
 */
const APP_SECTION_IDS: readonly HomepageAppSectionId[] = [
  'medications',
  'fhirSyncPebble',
  'importer',
  'webTrace',
]

/**
 * The copy that introduces one app: what it is, why it exists, and
 * how the reader can try it. Rendered on the marketing homepage's app rows
 * and on the app's own standalone landing page, so both surfaces tell the
 * same story from one source.
 */
interface AppDescription {
  /** The app's display name, used as the page heading on its landing page. */
  readonly name: string
  /** One plain sentence saying what the app does. */
  readonly tagline: string
  /**
   * The honest mono status line (`Status: in use`) on the homepage row only;
   * the landing page omits it, since an app someone has reached is usable.
   * Absent for apps the homepage presents as infrastructure.
   */
  readonly status?: string
  /** First-person paragraphs on why the app exists, in reading order. */
  readonly paragraphs: readonly string[]
  /**
   * A short numbered how-to shown on the landing page only (the homepage
   * presents the app, not its instructions): what a visitor has to do before
   * the app is useful to them.
   */
  readonly guide?: {
    /** The how-to's heading. */
    readonly title: string
    /** The steps, in order, one plain sentence or two each. */
    readonly steps: readonly string[]
    /** A caution or aside after the steps. */
    readonly note?: string
  }
  /** The homepage section the app's row sits in, where the rest of the project is. */
  readonly anchor: MarketingAnchor
  /**
   * The homepage's text-link call to action into the app. Absent for an app
   * with no homepage row, which has nowhere to show it.
   */
  readonly launch?: {
    /** Link text, without the trailing arrow the homepage adds. */
    readonly label: string
    /** The quiet mono note under the link, about the demo or live server. */
    readonly note: string
  }
  /**
   * The page, relative to the app's section, that starts the app's SMART launch
   * from its own URL: fhirclient reads `iss` there, and `launch` too for an EHR
   * launch, so `?iss=` alone is a standalone launch against that server. It is
   * the URL an EHR registers as the app's launch URL, and what a plain SMART
   * server's Home in the owner UI links each app through
   * ({@link smartAppLaunchPages}).
   *
   * Absent for an app no URL launches: the owner UI is not a SMART app, and FHIR
   * Sync for Pebble starts only from the Pebble phone app, whose watch hand-off
   * it needs, with its own connect menu as the sign-in.
   */
  readonly smartLaunchPage?: string
}

/**
 * The introduction for each app with a landing page, keyed by its site section.
 *
 * @remarks
 * The homepage is a first-person essay, and this copy keeps that voice: the
 * `paragraphs` explain why the app was built, not what it sells. The
 * `tagline` is the one sentence that says what the app is, for a reader who
 * arrived at the app's landing page without reading the homepage first.
 * Every app with a homepage row has a `launch`, since the row links into it.
 */
const APP_DESCRIPTIONS: {
  readonly [Id in AppSectionId]: Id extends HomepageAppSectionId
    ? AppDescription & Pick<Required<AppDescription>, 'launch'>
    : AppDescription
} = {
  medications: {
    name: 'Medication Viewer',
    tagline:
      "Every prescription on a patient's FHIR record, arranged around refill day, " +
      'from any server that speaks SMART on FHIR.',
    status: 'Status: in use',
    paragraphs: [
      'I want to get more out of my medication data than my pharmacy gives me.',
      'The viewer lays every refill and other key date onto a calendar, ' +
        'flags possible interactions between the prescriptions on the list, ' +
        'and points at manufacturer benefit programs that can bring the cost down.',
    ],
    anchor: 'built',
    launch: {
      label: 'Open the Medication Viewer',
      note: 'View the medications for a patient on any FHIR server, including our demo',
    },
    smartLaunchPage: 'launch.html',
  },
  fhirSyncPebble: {
    name: 'FHIR Sync for Pebble',
    tagline:
      'Syncs the steps, sleep and heart rate your Pebble already records to your FHIR server.',
    status: 'Status: early, rough edges',
    paragraphs: [
      'My Pebble already tracks my steps, sleep and heart rate, but that data never leaves ' +
        'the watch and my phone.',
      'This watchapp sends it to a FHIR server I choose, as observations on my own record, ' +
        'so it sits beside my labs and medications. It works with a Wildflower server, and ' +
        'with any SMART on FHIR server that lets a signed-in user grant system-level access.',
    ],
    guide: {
      title: 'Connecting your watch',
      steps: [
        "In the Pebble app on your phone, open the watchapp's settings. That opens this page.",
        'Connect to your FHIR server and sign in.',
        "Back on this page, pick the patient whose record your Pebble's data goes to.",
        'Check the patient, then save. The page closes and the watch starts syncing.',
      ],
      note:
        'The watch keeps a token that can list every patient on that server and add ' +
        'observations to any of them. ' +
        'Only connect a watch you wear yourself.',
    },
    anchor: 'built',
    launch: {
      label: 'Open FHIR Sync for Pebble',
      note: "Usually opened from the watchapp's settings in the Pebble app",
    },
  },
  importer: {
    name: 'Importer',
    tagline:
      'Turns what your browser saw on a pharmacy, lab, or patient-portal website ' +
      'into FHIR records on a server you control.',
    paragraphs: [
      "You can use your own browser, click around in your pharmacy / lab result / patient record's " +
        'website and save everything their server sent. ' +
        'The Importer can then process those results to produce FHIR compatible records, ' +
        'and save them on your server.',
    ],
    guide: {
      title: 'Collecting a HAR file from your browser',
      steps: [
        'Open the pharmacy, lab, or patient-portal website and sign in.',
        'Open the network panel. In Chrome or Edge, press Ctrl+Shift+I (Cmd+Option+I on a Mac) ' +
          'and click the Network tab. In Firefox, press Ctrl+Shift+E (Cmd+Option+E on a Mac) ' +
          'to open the Network Monitor.',
        'Keep requests across page loads. In Chrome or Edge, check the "Preserve log" checkbox. ' +
          'In Firefox, open the gear menu at the right of the toolbar and check "Persist Logs".',
        'Click through the pages whose data you want: prescriptions, results, visit summaries. ' +
          'Every request the site makes is recorded.',
        'Save the recording as a HAR file. In Chrome or Edge, right-click any request in the list ' +
          'and select "Save all as HAR with content". In Firefox, open the same gear menu and ' +
          'select "Save All As HAR".',
        'Come back here, connect to your server, and pick the saved .har file.',
      ],
      note:
        'A HAR file holds everything the site sent, including sign-in cookies and tokens. ' +
        'Keep it to yourself and to servers you control.',
    },
    anchor: 'try',
    launch: {
      label: 'Open the Importer',
      note: 'Import to any FHIR server, including a demo one',
    },
    smartLaunchPage: 'launch.html',
  },
  webTrace: {
    name: 'Web Trace Viewer',
    tagline:
      'Views the browser traces the Importer captures, stored as records on your FHIR server, ' +
      'and scrubs them so the shapes can be shared.',
    paragraphs: [
      'The Importer is built so that writing a module for a new site is easy. ' +
        'This app stores the traces you capture as records on your FHIR server, ' +
        'where you can view and edit them. ' +
        "If you can scrub your data on device, it's easy enough to share the data shape " +
        'with a developer or coding LLM. ' +
        'It replaces all your identifiers and data, with request and response shapes intact.',
    ],
    anchor: 'developers',
    launch: {
      label: 'Open the Web Trace Viewer',
      note: 'Load a capture against the demo server — no account, nothing uploaded',
    },
    smartLaunchPage: 'launch.html',
  },
  healthViewer: {
    name: 'Synthesized Health Viewer',
    tagline:
      "Plots labs, vitals and prescribed doses from a patient's FHIR record on one chart, " +
      'so a dose change can be read against the numbers it is meant to move.',
    status: 'Status: demo, rough edges',
    paragraphs: [
      'I want to see health data from several places on one chart.',
      'I have a dose of a medication that keeps changing from my pharmacy, and labs ' +
        'tracking both the medication level and possible side effects. It is hard to tell ' +
        'what all the changes are doing to each other. This tool plots data from several ' +
        'sources on the same chart so I can see how everything relates.',
    ],
    anchor: 'built',
    launch: {
      label: 'Open the Synthesized Health Viewer',
      note: 'Plot observations and doses for a patient on any FHIR server, including our demo',
    },
    smartLaunchPage: 'launch.html',
  },
  syntheticData: {
    name: 'Synthetic Data Loader',
    tagline:
      'Loads a published snapshot of synthetic health records into a FHIR server, ' +
      'so the other apps have a realistic record to show.',
    paragraphs: [
      "I want to show what Wildflower does without anyone's real health records.",
      'The synthetic data snapshot tells the stories of a few fictional people through the files ' +
        'a pharmacy, a lab and an imaging clinic would produce, read through the Importer. ' +
        'This app loads those records into a server you choose, so the viewers have ' +
        'something realistic to show.',
    ],
    guide: {
      title: 'Loading the snapshot',
      steps: [
        'Connect to the FHIR server to load into, and sign in.',
        "Check the snapshot's address. It starts at the published one.",
        'Choose the people to load, then load them. Loading again writes the same records ' +
          'over themselves.',
      ],
      note: 'Load it into a demo or test server, not one holding real records.',
    },
    anchor: 'developers',
    smartLaunchPage: 'launch.html',
  },
  lifting: {
    name: 'Lifting',
    tagline:
      'A strength-training program, the workout due today and every set you lift, ' +
      'kept on your own FHIR record.',
    paragraphs: [
      'I want my training log to live with the rest of my health record, ' +
        'not in one more app that keeps it to itself.',
      'A program is a cycle of workout days, each a list of exercises with their sets, reps ' +
        'and how the load moves. You tap off each set as you lift it, and after the workout ' +
        'the app raises, holds or deloads each lift from how it went. ' +
        'StrongLifts 5×5 is built in as a template.',
      'The program, the load you are at on each lift, each workout and each set are stored ' +
        'on your FHIR server as PlanDefinition, ServiceRequest, Procedure and Observation ' +
        'resources, so any other app you connect can read your training too.',
    ],
    anchor: 'built',
  },
  app: {
    name: 'Wildflower',
    tagline: 'Manages the devices, apps and health data on your own Wildflower server.',
    paragraphs: [
      'I want my health records on a server I control, not split across every clinic ' +
        "and pharmacy's portal. Wildflower is that server. It runs on your own computer, " +
        'or it can be hosted at your own wildflowerhealth.io address.',
      'This is where you look after it: connect the devices that record data for you, ' +
        'add apps and decide what each one can see. ' +
        'SMART on FHIR apps, like the ones on this site, launch against your own records.',
    ],
    anchor: 'try',
  },
}

/** Whether `key` names a described app: a key of {@link APP_DESCRIPTIONS}. */
const isAppSectionId = (key: string): key is AppSectionId => Object.hasOwn(APP_DESCRIPTIONS, key)

/** Where one hosted SMART app is launched from, on one copy of the assembled site. */
interface SmartAppLaunchPage {
  /** The app, keying its {@link APP_DESCRIPTIONS} entry. */
  readonly app: AppSectionId
  /** The absolute URL of the app's {@link AppDescription.smartLaunchPage}. */
  readonly launchPageUrl: string
}

/**
 * Every described app with a {@link AppDescription.smartLaunchPage}, in
 * {@link APP_DESCRIPTIONS} order, each with its launch page's URL under
 * `siteRoot`: the first-party SMART on FHIR apps the site hosts that a link
 * can launch, and nothing else.
 *
 * @param siteRoot - The slash-terminated root of the copy of the site to link
 *   into, from `siteRootFor`.
 *
 * @example
 * ```ts
 * smartAppLaunchPages('https://wildflowerhealth.io/')[0]
 * // → { app: 'medications', launchPageUrl: 'https://wildflowerhealth.io/medications-app/launch.html' }
 * ```
 */
const smartAppLaunchPages = (siteRoot: string): readonly SmartAppLaunchPage[] =>
  Object.keys(APP_DESCRIPTIONS)
    .filter(isAppSectionId)
    .flatMap((app) => {
      const { smartLaunchPage } = APP_DESCRIPTIONS[app]
      if (smartLaunchPage === undefined) return []
      const launchPageUrl = new URL(`${SECTION_PATHS[app]}/${smartLaunchPage}`, siteRoot).href
      return [{ app, launchPageUrl }]
    })

export { APP_DESCRIPTIONS, APP_SECTION_IDS, smartAppLaunchPages }
export type { AppDescription, AppSectionId, SmartAppLaunchPage }
