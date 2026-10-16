import type { QueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import type { PatientChoice } from '@wildflowerhealthio/smart-app-react'
import { useSyncExternalStore } from 'react'

import type { PageState, PageStore } from './page-state.ts'

/** The SMART client a completed handshake hands the app. */
type SmartClient = Extract<SmartHandshake, { readonly kind: 'ready' }>['client']

/**
 * What every route reads from the router: the SMART client the handshake
 * completed with, whose medications the page reads, and the page's choices.
 */
interface RouterContext {
  /** The page's one query cache, which the handshake ran on too. */
  readonly queryClient: QueryClient
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
  /** Whose medications the page reads. */
  readonly patientChoice: PatientChoice
  /** Go back to the patient picker: the patient line's "Change patient". */
  readonly changePatient: () => void
  /** The reader's choices that more than one tab reads. */
  readonly pageStore: PageStore
}

/** The SMART client the handshake completed with. */
const useSmartClient = (): SmartClient =>
  useRouteContext({ from: '__root__', select: (context) => context.client })

/** Whose medications the page reads. */
const useChosenPatient = (): PatientChoice =>
  useRouteContext({ from: '__root__', select: (context) => context.patientChoice })

/** Going back to the patient picker. */
const useChangePatient = (): (() => void) =>
  useRouteContext({ from: '__root__', select: (context) => context.changePatient })

/**
 * The part of the page's {@link PageState} `select` picks, kept current, and
 * how to change the state.
 */
const usePageState = <A>(select: (state: PageState) => A): readonly [A, PageStore['update']] => {
  const pageStore = useRouteContext({ from: '__root__', select: (context) => context.pageStore })
  const selected = useSyncExternalStore(pageStore.subscribe, () => select(pageStore.snapshot()))
  return [selected, pageStore.update]
}

export { useChangePatient, useChosenPatient, usePageState, useSmartClient }
export type { RouterContext, SmartClient }
