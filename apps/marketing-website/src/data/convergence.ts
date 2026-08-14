/*
 * Data + derivation logic for the interactive "Convergence" section.
 *
 * A connectable app is granted to read a set of FHIR-style resource types.
 * Selecting an app highlights every chip whose type it reads and keeps a
 * source row lit when the row shares at least one of those types. The
 * highlighting is entirely derived from the selected app — the component
 * holds a single `selectedApp` state and reads everything else from here,
 * which is why these helpers are pure and unit-tested in isolation.
 */

/** Resource types a source can expose and an app can be granted to read. */
type ResourceType = 'prescriptions' | 'labresults' | 'labreq' | 'appointments'

/** The connectable apps shown in the right-hand column. */
type AppId = 'refill' | 'insights' | 'schedule'

type ConnectApp = {
  readonly id: AppId
  readonly title: string
  readonly pitch: string
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
}

const CONNECT_APPS: readonly ConnectApp[] = [
  {
    id: 'refill',
    title: 'Refill reminder',
    pitch: 'Nudges you before a prescription runs out.',
    reads: ['prescriptions'],
  },
  {
    id: 'insights',
    title: 'Health insights',
    pitch: 'Surfaces trends across your labs and medications over time.',
    reads: ['prescriptions', 'labresults'],
  },
  {
    id: 'schedule',
    title: 'Scheduling assistant',
    pitch: 'Books and preps your visits from your requisitions and appointments.',
    reads: ['labreq', 'appointments'],
  },
]

const RECORD_SOURCES: readonly RecordSource[] = [
  { id: 'rexall', name: 'Rexall', category: 'Pharmacy', chips: ['prescriptions'] },
  { id: 'shoppers', name: 'Shoppers Drug Mart', category: 'Pharmacy', chips: ['prescriptions'] },
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

/** The app selected on first paint. */
const DEFAULT_APP: AppId = 'insights'

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

export type { AppId, ConnectApp, RecordSource, ResourceType }
export {
  CONNECT_APPS,
  DEFAULT_APP,
  isSourceActive,
  isTypeActive,
  readsFor,
  RECORD_SOURCES,
  TYPE_LABELS,
}
