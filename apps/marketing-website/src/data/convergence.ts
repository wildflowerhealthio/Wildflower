import { sectionRootPath } from 'branding-core'

/*
 * Data + derivation logic for the "collection of apps" section.
 *
 * An app in the collection is granted to read a set of FHIR-style resource
 * types. Selecting an app highlights every chip whose type it reads and keeps a
 * source row lit when the row shares at least one of those types. The
 * highlighting is entirely derived from the selected app — the component holds
 * a single `selectedApp` state and reads everything else from here, which is
 * why these helpers are pure and unit-tested in isolation.
 *
 * Every entry describes something that exists or is openly labelled as a
 * concept: `availability` carries that distinction into the UI, and only an
 * app that is published on this domain carries an `href`.
 */

/** Resource types a source can expose and an app can be granted to read. */
type ResourceType = 'prescriptions' | 'labresults' | 'labreq' | 'appointments' | 'documents'

/** The apps shown in the collection. */
type AppId = 'medications' | 'importer' | 'webtrace' | 'visits'

/** How far along an app is — shown on its card so nothing reads as shipped that isn't. */
type Availability = 'published' | 'in-app' | 'concept'

type ConnectApp = {
  readonly id: AppId
  readonly title: string
  readonly pitch: string
  readonly availability: Availability
  /** Where the app is published on this domain, when it is. */
  readonly href?: string
  readonly reads: readonly ResourceType[]
}

/** A normalized source (pharmacy, clinic, lab) in the standardized record. */
type RecordSource = {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly chips: readonly ResourceType[]
}

/** Human label for each resource type — single source of truth for chips. */
const TYPE_LABELS: Record<ResourceType, string> = {
  prescriptions: 'Prescriptions',
  labresults: 'Lab results',
  labreq: 'Lab requisitions',
  appointments: 'Appointments',
  documents: 'Imported documents',
}

/** Human label for each availability state. */
const AVAILABILITY_LABELS: Record<Availability, string> = {
  published: 'Try it now',
  'in-app': 'In the Wildflower app',
  concept: 'In design',
}

const CONNECT_APPS: readonly ConnectApp[] = [
  {
    id: 'medications',
    title: 'Medications',
    pitch:
      'Your prescriptions in one list — active and completed, each with its prescriber, notes and DIN, the repeats you have left and when the supply runs out. It checks both brand and generic coverage against the innoviCares and RxHelp programs for any province or territory, links the ones you qualify for, and opens the Rexall or Shoppers Drug Mart store that dispensed the script. It launches from your record, or from any EHR that speaks SMART on FHIR.',
    availability: 'published',
    href: sectionRootPath('medications'),
    reads: ['prescriptions'],
  },
  {
    id: 'importer',
    title: 'Importer',
    pitch:
      'Import FHIR records from a captured browsing session. Point it at a HAR file — one Wildflower recorded while you were signed in to a portal or a pharmacy site, or one you exported yourself — and it shows you exactly which records it found and what it would write before it writes anything. Nothing is saved until you confirm, and everything it does save is stamped with the archive it came from.',
    availability: 'published',
    href: sectionRootPath('importer'),
    reads: ['documents'],
  },
  {
    id: 'webtrace',
    title: 'Web Trace',
    pitch:
      'The receipts. Review every browsing session Wildflower recorded while importing from a portal or a pharmacy site, see exactly what was captured, and export any of it as a standard HAR file.',
    availability: 'published',
    href: sectionRootPath('webTrace'),
    reads: ['documents'],
  },
  {
    id: 'visits',
    title: 'Visits',
    pitch:
      'A concept we are designing: turn a requisition into a booked appointment, and walk in with the results that appointment is about.',
    availability: 'concept',
    reads: ['labreq', 'appointments', 'labresults'],
  },
]

const RECORD_SOURCES: readonly RecordSource[] = [
  { id: 'rexall', name: 'Rexall', category: 'Pharmacy', chips: ['prescriptions', 'documents'] },
  {
    id: 'shoppers',
    name: 'Shoppers Drug Mart',
    category: 'Pharmacy',
    chips: ['prescriptions', 'documents'],
  },
  {
    id: 'okafor',
    name: "Dr. Okafor's office",
    category: 'Family practice',
    chips: ['appointments', 'labreq'],
  },
  {
    id: 'lifelabs',
    name: 'LifeLabs',
    category: 'Diagnostics',
    chips: ['labresults', 'appointments'],
  },
]

/** The app selected on first paint — the one you can actually open. */
const DEFAULT_APP: AppId = 'medications'

/** The resource types the given app is granted to read. */
const readsFor = (appId: AppId): readonly ResourceType[] =>
  CONNECT_APPS.find((app) => app.id === appId)?.reads ?? []

/** Whether a chip's resource type is in the selected app's read-set. */
const isTypeActive = (appId: AppId, type: ResourceType): boolean => readsFor(appId).includes(type)

/**
 * Whether a source row stays fully lit: true when any of its chip types is
 * in the selected app's read-set, false when the row should dim.
 */
const isSourceActive = (appId: AppId, source: RecordSource): boolean =>
  source.chips.some((type) => isTypeActive(appId, type))

export type { AppId, Availability, ConnectApp, RecordSource, ResourceType }
export {
  AVAILABILITY_LABELS,
  CONNECT_APPS,
  DEFAULT_APP,
  isSourceActive,
  isTypeActive,
  readsFor,
  RECORD_SOURCES,
  TYPE_LABELS,
}
