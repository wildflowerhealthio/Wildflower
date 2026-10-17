import { cleanup, screen } from '@testing-library/react'
import type {
  MedicationRequestCursor,
  MedicationRequestPage,
  PatientPage,
  SmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationRequest, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import type { InteractionCatalog } from '@wildflowerhealthio/medication-interaction-core-js'
import { Effect, Option, Schema } from 'effect'
import type Client from 'fhirclient/lib/Client'
import { afterEach, beforeEach, expect, vi } from 'vite-plus/test'

// The seams `App` composes: the handshake hook (its state is driven per
// test), the paged MedicationRequest read (whose page / rejection is stubbed,
// and whose cursor records the patient scope), the Patient reads behind the
// patient picker and the patient line, and the DDInter catalog load
// (unresolved by default so interaction tests control it). The real
// `useSmartHandshake` dedup is covered in the slice, and the picker in
// `smart-app-react`; the tests drive their results to exercise the app's own
// query wiring, routing, paging, the load-everything driver, and error
// surfacing.

/** The handshake each render sees. */
const handshakeMock = vi.fn<() => SmartHandshake>()
/** One MedicationRequest page read, by its cursor. */
const fetchMock = vi.fn<(cursor: MedicationRequestCursor) => Promise<MedicationRequestPage>>()
/** One page of the picker's patients. */
const patientPageMock = vi.fn<() => Promise<PatientPage>>()
/** The DDInter catalog load. */
const catalogMock = vi.fn<() => Promise<unknown>>()
/** Carrying a failed handshake back to the app root. */
const launchFailureRedirectMock = vi.fn<(handshake: SmartHandshake) => void>()

/**
 * The test double of `@wildflowerhealthio/fhir-r4-react/smart`, over the
 * mocks above; a test file mocks the module with it:
 *
 * ```ts
 * vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async () =>
 *   (await import('../test-utils/app-fakes.ts')).smartModuleFake()
 * )
 * ```
 *
 * It imports nothing of the app's, so the mock factory loads it without
 * loading the module it stands in for.
 */
const smartModuleFake = (): Record<string, unknown> => ({
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (handshake: SmartHandshake) => {
    launchFailureRedirectMock(handshake)
  },
  fetchMedicationRequestPage: (_client: unknown, cursor: MedicationRequestCursor) =>
    Effect.promise(() => fetchMock(cursor)),
  fetchPatientPage: () => Effect.promise(() => patientPageMock()),
  fetchPatient: (_client: unknown, patientId: string) =>
    Effect.succeed(Option.some({ resourceType: 'Patient', id: patientId, name: [] })),
})

/** The test double of the routes' `-interaction-catalog.ts`, over {@link catalogMock}. */
const interactionCatalogModuleFake = (): Record<string, unknown> => ({
  getInteractionCatalog: () => catalogMock(),
})

/** The directory the app is served from in these tests. */
const BASEPATH = '/medications/'

/** A completed handshake whose launch put `patientId` in context. */
const handshakeLaunchedWith = (patientId: string | null): SmartHandshake => ({
  kind: 'ready',
  // The client is only forwarded to the (mocked) reads, and its launch patient read.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub, forwarded to a mock
  client: { patient: { id: patientId } } as unknown as Client,
})

/** A launch with patient `p1` in context, which the app opens on. */
const readyHandshake = handshakeLaunchedWith('p1')

/** An empty terminal page: no rows, no further cursor. */
const lastPage: MedicationRequestPage = { items: [], nextPageUrl: null, droppedEntryCount: 0 }

/** One page of patients for the picker: Ada Lovelace, `p2`. */
const patientPage: PatientPage = {
  items: [
    Schema.decodeUnknownSync(Patient.Schema)({
      resourceType: 'Patient',
      id: 'p2',
      name: [{ given: ['Ada'], family: 'Lovelace' }],
    }),
  ],
  nextPageUrl: null,
  droppedEntryCount: 0,
}

/** A non-terminal empty page pointing at the given next cursor. */
const pageTo = (next: number): MedicationRequestPage => ({
  items: [],
  nextPageUrl: `https://fhir.example/MedicationRequest?p=${next}`,
  droppedEntryCount: 0,
})

/** Decode a request the way the paged read does: with its server `id` required. */
const decodeRequest = Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))

/** An active atorvastatin request under the given server `id`. */
const atorvastatin = (id: string): MedicationRequestPage['items'][number] =>
  decodeRequest({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject: { reference: 'Patient/1' },
    medicationCodeableConcept: { text: 'Atorvastatin 20 mg tablet' },
  })

/** A valid, empty DDInter catalog: enough for the report shell to render. */
const emptyCatalog: InteractionCatalog = {
  source: { name: 'DDInter', url: 'https://ddinter.scbdd.com/' },
  drugs: [],
  pairs: new Map(),
}

/** Ready handshake + the given pages, ending on a terminal page. */
const arrangePages = (pageCount: number): void => {
  handshakeMock.mockReturnValue(readyHandshake)
  for (let page = 1; page < pageCount; page += 1) {
    fetchMock.mockResolvedValueOnce(pageTo(page + 1))
  }
  fetchMock.mockResolvedValueOnce(lastPage)
}

/** A quiet IntersectionObserver: the sentinel mounts but never fires. */
const stubQuietIntersectionObserver = (): void => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
}

/** Wait for the first page to land: the tabs replace the loading line. */
const awaitFirstPage = async (): Promise<void> => {
  expect(await screen.findByRole('navigation', { name: 'Medication views' })).toBeDefined()
}

/** The tab strip's link to `label`. */
const tabLink = (label: string): HTMLElement => screen.getByRole('link', { name: label })

/** The address bar's path under {@link BASEPATH}. */
const currentRoute = (): string => window.location.pathname.slice(BASEPATH.length)

/**
 * A `ResizeObserver` that never fires: jsdom has no layout, and nothing these
 * tests check hangs on a resize (the page's `RouteTabs` observes its strip).
 */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** `Element.scrollTo` as it was before each test, which jsdom leaves undefined. */
const scrollToDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')

/**
 * Register, for each test of the calling file, the browser APIs the page
 * needs that jsdom lacks (`ResizeObserver`, `matchMedia`, `Element.scrollTo`),
 * and afterwards unmount, put them back, and reset every fake to its default:
 * the catalog unresolved. Call it once at the top level of a file that renders
 * the app.
 */
const setUpEachAppTest = (): void => {
  beforeEach(() => {
    // `RouteTabs` scrolls its strip to the current tab, and asks whether
    // motion is reduced, through APIs jsdom lacks.
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    Element.prototype.scrollTo = () => {}
    // Unresolved by default: interaction tests opt into a resolved catalog.
    catalogMock.mockReturnValue(new Promise(() => {}))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (scrollToDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollTo')
    else Object.defineProperty(Element.prototype, 'scrollTo', scrollToDescriptor)
    handshakeMock.mockReset()
    fetchMock.mockReset()
    patientPageMock.mockReset()
    catalogMock.mockReset()
    launchFailureRedirectMock.mockReset()
  })
}

export {
  arrangePages,
  atorvastatin,
  awaitFirstPage,
  BASEPATH,
  catalogMock,
  currentRoute,
  emptyCatalog,
  fetchMock,
  handshakeLaunchedWith,
  handshakeMock,
  interactionCatalogModuleFake,
  lastPage,
  launchFailureRedirectMock,
  pageTo,
  patientPage,
  patientPageMock,
  readyHandshake,
  setUpEachAppTest,
  smartModuleFake,
  stubQuietIntersectionObserver,
  tabLink,
}
