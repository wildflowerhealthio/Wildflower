import { useRouteContext } from '@tanstack/react-router'
import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type { PatientChoice } from '@wildflowerhealthio/smart-app-react'

import type { SmartClient } from './smart-client.ts'

/**
 * What every route reads from the router: the SMART client the handshake
 * completed with, the write runner over it, and whose record the page shows.
 */
interface RouterContext {
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
  /** Whose record the page shows: one lifter's, or every patient's, read-only. */
  readonly patientChoice: PatientChoice
  /** Go back to the patient picker: the patient line's "Change patient". */
  readonly changePatient: () => void
  /**
   * The id the StrongLifts 5×5 template is stored under if it is started,
   * minted once per router, so a retried start on any tab writes the same id.
   */
  readonly strongLiftsPlanDefinitionId: string
}

/** The SMART client the handshake completed with. */
const useSmartClient = (): SmartClient =>
  useRouteContext({ from: '__root__', select: (context) => context.client })

/** The runner every write goes through. */
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context) => context.runAuthed })

/** Whose record the page shows. */
const useChosenPatient = (): PatientChoice =>
  useRouteContext({ from: '__root__', select: (context) => context.patientChoice })

/** Going back to the patient picker. */
const useChangePatient = (): (() => void) =>
  useRouteContext({ from: '__root__', select: (context) => context.changePatient })

/** The id the StrongLifts 5×5 template is stored under if it is started. */
const useStrongLiftsPlanDefinitionId = (): string =>
  useRouteContext({ from: '__root__', select: (context) => context.strongLiftsPlanDefinitionId })

export {
  useChangePatient,
  useChosenPatient,
  useRunAuthed,
  useSmartClient,
  useStrongLiftsPlanDefinitionId,
}
export type { RouterContext }
