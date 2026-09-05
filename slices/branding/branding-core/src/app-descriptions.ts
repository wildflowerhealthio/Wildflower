import type { MarketingAnchor } from './nav.ts'
import type { SectionId } from './site.ts'

/** The site sections that are SMART on FHIR apps with a standalone landing page. */
type AppSectionId = Extract<SectionId, 'medications' | 'importer' | 'webTrace'>

/** The three SMART app sections, in the order the marketing homepage presents them. */
const APP_SECTION_IDS: readonly AppSectionId[] = ['medications', 'importer', 'webTrace']

/**
 * The copy that introduces one SMART app: what it is, why it exists, and
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
  /** The homepage's text-link call to action into the app. */
  readonly launch: {
    /** Link text, without the trailing arrow the homepage adds. */
    readonly label: string
    /** The quiet mono note under the link, about the demo or live server. */
    readonly note: string
  }
}

/**
 * The introduction for each SMART app, keyed by its site section.
 *
 * @remarks
 * The homepage is a first-person essay, and this copy keeps that voice: the
 * `paragraphs` explain why the app was built, not what it sells. The
 * `tagline` is the one sentence that says what the app is, for a reader who
 * arrived at the app's landing page without reading the homepage first.
 */
const APP_DESCRIPTIONS: { readonly [Id in AppSectionId]: AppDescription } = {
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
  },
}

export { APP_DESCRIPTIONS, APP_SECTION_IDS }
export type { AppDescription, AppSectionId }
