import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { InteractionCatalog } from '@wildflowerhealthio/medication-interaction-core-js'
import { InteractionsView } from '@wildflowerhealthio/medication-interaction-react'
import type { Medication } from '@wildflowerhealthio/medication-sponsorship-core-js'
import { GateCard, PartialBanner } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'

import {
  type MedicationRead,
  useCurrentMedications,
  useMedicationRead,
} from '../-medication-read.ts'
import { usePageState } from '../../router-context.ts'
import { getInteractionCatalog } from './-interaction-catalog.ts'
import styles from './-interactions.module.css'

/**
 * `true` once `active` has held for `delayMs`: keeps the gate from flashing
 * when a short list finishes loading almost immediately.
 */
const useDelayedFlag = (active: boolean, delayMs: number): boolean => {
  const [passed, setPassed] = useState(false)
  // Both transitions go through the timer (deactivation at 0ms), so no
  // setState runs synchronously inside the effect.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setPassed(active)
      },
      active ? delayMs : 0
    )
    return () => {
      clearTimeout(timer)
    }
  }, [active, delayMs])
  return passed && active
}

/** What the Interactions tab shows. */
interface InteractionsTabModel {
  readonly read: MedicationRead
  /** The interaction catalog's load. */
  readonly catalog: {
    readonly data: InteractionCatalog | undefined
    readonly error: unknown
    readonly isError: boolean
  }
  /** Whether the report waits for the full list. */
  readonly gated: boolean
  /** Whether the gate has been up long enough to show. */
  readonly gateVisible: boolean
  /** Whether the reader chose to see the report as pages arrive. */
  readonly partialInteractionsShown: boolean
  readonly showPartialInteractions: () => void
  readonly currentMedications: readonly Medication[]
  readonly prescriberOf: (medication: Medication) => string | null
}

/**
 * The Interactions tab's logic.
 *
 * @remarks
 * The interaction catalog is a ~2 MB asset fetched (and decoded once) only
 * when this tab first opens, and it never goes stale within a visit. The
 * report gates on the *full* medication list, a missing medication being a
 * missing interaction, unless the reader chooses to see it as pages arrive;
 * the gate is held back for its first 400ms so a short list never flashes it.
 */
const useInteractionsTab = (): InteractionsTabModel => {
  const read = useMedicationRead()
  const [partialInteractionsShown, updatePageState] = usePageState(
    (state) => state.partialInteractionsShown
  )
  const catalog = useQuery({
    queryKey: ['interaction-catalog'],
    queryFn: getInteractionCatalog,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  })
  const gated = !read.listComplete && !partialInteractionsShown
  // Prescriber (requester) display name per medication id, for the avatars
  // the report shows between the patient's own medications.
  const prescriberById = useMemo(() => {
    const map = new Map<string, string>()
    for (const view of read.views) {
      if (view.requester !== null) map.set(view.medication.id, view.requester)
    }
    return map
  }, [read.views])
  return {
    read,
    catalog,
    gated,
    gateVisible: useDelayedFlag(gated, 400),
    partialInteractionsShown,
    showPartialInteractions: () => {
      updatePageState({ partialInteractionsShown: true })
    },
    currentMedications: useCurrentMedications(read.views),
    prescriberOf: useCallback(
      (medication: Medication): string | null => prescriberById.get(medication.id) ?? null,
      [prescriberById]
    ),
  }
}

/**
 * The Interactions tab: the three-group report over the current medications,
 * checked against the bundled DDInter catalog, behind a gate until the full
 * list has landed.
 */
function InteractionsTab(): JSX.Element | null {
  const {
    read,
    catalog,
    gated,
    gateVisible,
    partialInteractionsShown,
    showPartialInteractions,
    currentMedications,
    prescriberOf,
  } = useInteractionsTab()
  const { pagedQuery, listComplete, barPhase, requestEveryPage } = read
  const { isFetchNextPageError } = pagedQuery
  // Each arm names the fields it depends on as a partial-object pattern;
  // earlier arms win, so the order is priority order.
  return Match.value({
    catalogError: catalog.isError,
    catalogData: catalog.data,
    gated,
    gateVisible,
    isFetchNextPageError,
    barPhase,
  }).pipe(
    Match.when({ catalogError: true }, (): JSX.Element => (
      <p className={styles['interactions__error']}>
        {catalog.error instanceof Error
          ? catalog.error.message
          : 'Could not load the interaction database.'}
      </p>
    )),
    Match.when({ gated: true, gateVisible: false }, (): JSX.Element | null => null),
    Match.when({ gated: true, isFetchNextPageError: true }, (): JSX.Element => (
      <GateCard
        title="Couldn't load part of your list"
        body="A page of your medication list failed to load. Interactions stay paused until it arrives — retrying re-requests just that page."
        showSpinner={false}
        action={{ label: 'Retry', onClick: requestEveryPage }}
      />
    )),
    Match.when({ gated: true, barPhase: 'loading' as const }, (): JSX.Element => (
      <GateCard
        title="Waiting for your full medication list"
        body="Interactions are checked against every medication at once — a partial list could miss one."
        action={{ label: 'Show me it live as it loads anyway', onClick: showPartialInteractions }}
      />
    )),
    Match.when({ gated: true }, (): JSX.Element => (
      <GateCard
        title="Only part of your medication list is loaded"
        body="Interactions are checked against every medication at once — a partial list could miss one."
        showSpinner={false}
        action={{ label: 'Load the rest of my medications', onClick: requestEveryPage }}
      />
    )),
    Match.when(
      // The catalog usually resolves long before the medication list; this
      // covers the rare visit where the list finishes (or goes partial) first.
      { catalogData: undefined },
      (): JSX.Element => (
        <GateCard
          title="Preparing the interaction checker"
          body="Loading the interaction database — a one-time download for this visit."
        />
      )
    ),
    Match.when({ catalogData: Match.defined }, ({ catalogData }): JSX.Element => (
      <>
        {partialInteractionsShown &&
          !listComplete &&
          (isFetchNextPageError ? (
            // The driver has halted on a failed page: say so and offer a
            // retry, rather than claiming it is "still loading" indefinitely.
            <PartialBanner action={{ label: 'Retry', onClick: requestEveryPage }}>
              A page of your medication list failed to load. Interactions with the medications that
              haven't loaded yet are missing.
            </PartialBanner>
          ) : (
            <PartialBanner>
              Partial list — still loading. Interactions with medications that haven't loaded yet
              are missing.
            </PartialBanner>
          ))}
        <InteractionsView
          medications={currentMedications}
          catalog={catalogData}
          prescriberOf={prescriberOf}
        />
      </>
    )),
    Match.exhaustive
  )
}

/**
 * `/interactions`, the Interactions tab.
 *
 * @remarks
 * Opening it, by its tab or by a link straight to it, asks for every page of
 * the medication list: the report can't be computed from a partial list, so
 * the reader never has to ask for it here. The other tabs render from
 * whatever pages have landed.
 */
const Route = createFileRoute('/interactions')({
  onEnter: ({ context }) => {
    context.pageStore.update({ everyPageRequested: true })
  },
  component: InteractionsTab,
})

export { Route }
